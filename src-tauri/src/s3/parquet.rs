//! Parquet preview through ranged GETs: the footer (one request for the file's tail) and then
//! only the pages that hold the requested rows. The file is never downloaded as a whole.

use super::S3;
use arrow_json::writer::JsonArray;
use bytes::Bytes;
use futures_util::future::{BoxFuture, FutureExt};
use futures_util::TryStreamExt;
use parquet::arrow::arrow_reader::{ArrowReaderMetadata, ArrowReaderOptions};
use parquet::arrow::async_reader::AsyncFileReader;
use parquet::arrow::ParquetRecordBatchStreamBuilder;
use parquet::errors::{ParquetError, Result as ParquetResult};
use parquet::file::metadata::{PageIndexPolicy, ParquetMetaData, ParquetMetaDataReader};
use serde::Serialize;
use serde_json::Value;
use std::ops::Range;
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::sync::{Arc, Mutex};

/// How much of the file's tail the first request asks for. The footer and the page index of
/// an ordinary file fit in it, so opening a file costs one request.
const FOOTER_HINT: usize = 8 * 1024 * 1024;
/// Rows per page of the preview table, at most.
pub const MAX_ROWS: usize = 500;
/// Longer strings are cut for display.
const MAX_CELL_CHARS: usize = 2000;
/// Integers beyond this lose digits as JavaScript numbers.
const MAX_SAFE_INT: u64 = 1 << 53;

/// The decoded footer of one object, keyed by `bucket/key@version#etag`.
pub(crate) type FooterCache = Arc<Mutex<Option<(String, ArrowReaderMetadata)>>>;

#[derive(Debug, Serialize)]
pub struct ParquetColumn {
    pub name: String,
    /// Arrow type as text, e.g. `Int64`, `List(Utf8)`, `Struct(...)`.
    pub data_type: String,
}

#[derive(Debug, Serialize)]
pub struct ParquetPage {
    pub columns: Vec<ParquetColumn>,
    pub total_rows: u64,
    pub row_groups: usize,
    pub offset: u64,
    /// One JSON object per row, keyed by column name; nested values stay JSON.
    pub rows: Vec<Value>,
    pub file_size: u64,
    /// What this page cost: bytes fetched from RGW and the number of range requests.
    pub fetched_bytes: u64,
    pub requests: u64,
}

struct RangedReader {
    s3: S3,
    bucket: String,
    key: String,
    version: Option<String>,
    size: u64,
    fetched: Arc<AtomicU64>,
    requests: Arc<AtomicU64>,
}

impl AsyncFileReader for RangedReader {
    fn get_bytes(&mut self, range: Range<u64>) -> BoxFuture<'_, ParquetResult<Bytes>> {
        async move {
            let len = range.end - range.start;
            let read = self
                .s3
                .read_range(
                    &self.bucket,
                    &self.key,
                    self.version.as_deref(),
                    range.start,
                    len,
                )
                .await;
            let bytes = read.map_err(|e| ParquetError::External(e.into()))?;
            self.fetched.fetch_add(bytes.len() as u64, Relaxed);
            self.requests.fetch_add(1, Relaxed);
            Ok(Bytes::from(bytes))
        }
        .boxed()
    }

    fn get_metadata<'a>(
        &'a mut self,
        _options: Option<&'a ArrowReaderOptions>,
    ) -> BoxFuture<'a, ParquetResult<Arc<ParquetMetaData>>> {
        async move {
            let size = self.size;
            let reader = ParquetMetaDataReader::new()
                // The offset index is what lets a page of rows be fetched without its whole column chunk.
                .with_page_index_policy(PageIndexPolicy::Optional)
                .with_prefetch_hint(Some(FOOTER_HINT));
            Ok(Arc::new(reader.load_and_finish(self, size).await?))
        }
        .boxed()
    }
}

/// Makes a decoded value safe to show: big integers become strings (JavaScript would round
/// them), very long strings are cut.
fn displayable(value: &mut Value) {
    match value {
        Value::Number(n) => {
            let too_big = n.as_i64().is_some_and(|i| i.unsigned_abs() > MAX_SAFE_INT)
                || n.as_u64().is_some_and(|u| u > MAX_SAFE_INT);
            if too_big {
                *value = Value::String(n.to_string());
            }
        }
        Value::String(s) => {
            if let Some((cut, _)) = s.char_indices().nth(MAX_CELL_CHARS) {
                let rest = s[cut..].chars().count();
                s.truncate(cut);
                // No word of any language: the UI shows this cell as it is.
                s.push_str(&format!("… (+{rest})"));
            }
        }
        Value::Array(items) => items.iter_mut().for_each(displayable),
        Value::Object(fields) => fields.values_mut().for_each(displayable),
        Value::Null | Value::Bool(_) => {}
    }
}

/// Row groups that hold rows `[offset, offset + limit)` and how many rows to skip in the
/// first of them. `sizes` are the row counts of the file's row groups, in order.
fn groups_for(sizes: &[u64], offset: u64, limit: u64) -> (Vec<usize>, u64) {
    let (mut groups, mut skip, mut start) = (Vec::new(), 0, 0);
    for (i, rows) in sizes.iter().enumerate() {
        let end = start + rows;
        if end > offset && start < offset + limit {
            if groups.is_empty() {
                skip = offset - start;
            }
            groups.push(i);
        }
        start = end;
    }
    (groups, skip)
}

impl S3 {
    /// Rows `[offset, offset + limit)` of a Parquet object, with the schema and row count.
    pub async fn parquet_page(
        &self,
        bucket: &str,
        key: &str,
        version: Option<&str>,
        offset: u64,
        limit: usize,
    ) -> Result<ParquetPage, String> {
        let limit = limit.clamp(1, MAX_ROWS);
        let head = self.head(bucket, key, version).await?;
        let file_size = head.size;
        // The ETag is part of the id: a replaced object must not be read with the old footer.
        let id = format!("{bucket}/{key}@{}#{}", version.unwrap_or(""), head.etag);
        let (fetched, requests) = (Arc::new(AtomicU64::new(0)), Arc::new(AtomicU64::new(0)));
        let mut reader = RangedReader {
            s3: self.clone(),
            bucket: bucket.to_string(),
            key: key.to_string(),
            version: version.map(str::to_string),
            size: file_size,
            fetched: fetched.clone(),
            requests: requests.clone(),
        };
        let not_parquet = |e: ParquetError| format!("cannot read this file as Parquet: {e}");
        let options = ArrowReaderOptions::new().with_page_index_policy(PageIndexPolicy::Optional);
        let cached = self.parquet_footer.lock().ok().and_then(|cache| {
            let hit = cache.as_ref().filter(|(cached_id, _)| *cached_id == id);
            hit.map(|(_, footer)| footer.clone())
        });
        let footer = match cached {
            Some(footer) => footer,
            None => {
                let loaded = ArrowReaderMetadata::load_async(&mut reader, options).await;
                let footer = loaded.map_err(not_parquet)?;
                if let Ok(mut cache) = self.parquet_footer.lock() {
                    *cache = Some((id, footer.clone()));
                }
                footer
            }
        };
        let builder = ParquetRecordBatchStreamBuilder::new_with_metadata(reader, footer);

        let metadata = builder.metadata().clone();
        let total_rows = metadata.file_metadata().num_rows().max(0) as u64;
        let columns = builder
            .schema()
            .fields()
            .iter()
            .map(|f| ParquetColumn {
                name: f.name().clone(),
                data_type: f.data_type().to_string(),
            })
            .collect();
        let sizes: Vec<u64> = metadata
            .row_groups()
            .iter()
            .map(|g| g.num_rows().max(0) as u64)
            .collect();
        let (groups, skip) = groups_for(&sizes, offset, limit as u64);

        let mut rows = Vec::new();
        if !groups.is_empty() {
            let stream = builder
                .with_row_groups(groups)
                .with_offset(skip as usize)
                .with_limit(limit)
                .with_batch_size(limit)
                .build()
                .map_err(not_parquet)?;
            let batches: Vec<_> = stream.try_collect().await.map_err(not_parquet)?;
            let mut writer = arrow_json::WriterBuilder::new()
                .with_explicit_nulls(true)
                .build::<_, JsonArray>(Vec::new());
            for batch in &batches {
                writer.write(batch).map_err(|e| e.to_string())?;
            }
            writer.finish().map_err(|e| e.to_string())?;
            let json = writer.into_inner();
            if !json.is_empty() {
                rows = serde_json::from_slice(&json).map_err(|e| e.to_string())?;
            }
            rows.iter_mut().for_each(displayable);
        }
        Ok(ParquetPage {
            columns,
            total_rows,
            row_groups: sizes.len(),
            offset,
            rows,
            file_size,
            fetched_bytes: fetched.load(Relaxed),
            requests: requests.load(Relaxed),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn picks_only_the_row_groups_a_page_touches() {
        let sizes = [100, 100, 50];
        assert_eq!(groups_for(&sizes, 0, 10), (vec![0], 0));
        assert_eq!(groups_for(&sizes, 95, 10), (vec![0, 1], 95));
        assert_eq!(groups_for(&sizes, 100, 10), (vec![1], 0));
        assert_eq!(groups_for(&sizes, 240, 50), (vec![2], 40));
        assert_eq!(groups_for(&sizes, 0, 1000), (vec![0, 1, 2], 0));
        assert_eq!(groups_for(&sizes, 250, 10), (vec![], 0), "past the end");
        assert_eq!(groups_for(&[], 0, 10), (vec![], 0));
    }

    #[test]
    fn values_are_made_displayable() {
        let long = "é".repeat(MAX_CELL_CHARS + 5);
        let mut row = json!({
            "id": 9007199254740993u64,
            "neg": -9007199254740993i64,
            "small": 42,
            "ratio": 0.5,
            "nested": {"ids": [1, 18446744073709551615u64], "text": long},
        });
        displayable(&mut row);
        assert_eq!(row["id"], "9007199254740993");
        assert_eq!(row["neg"], "-9007199254740993");
        assert_eq!(row["small"], 42);
        assert_eq!(row["ratio"], 0.5);
        assert_eq!(row["nested"]["ids"], json!([1, "18446744073709551615"]));
        let cut = row["nested"]["text"].as_str().unwrap();
        assert!(cut.ends_with("… (+5)"), "{}", &cut[cut.len() - 30..]);
        assert_eq!(cut.chars().filter(|c| *c == 'é').count(), MAX_CELL_CHARS);
    }
}
