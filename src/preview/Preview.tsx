import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Box, Button, LinearProgress, Stack, TextField, Typography } from "@mui/material";
import { invoke } from "../api";
import { formatBytes } from "../format";
import type { ObjectAt, ObjectTabProps } from "../ObjectDrawer";
import { CopyButton, ErrorAlert, useAction } from "../ui";
import { VirtualTable, type Column } from "../virtual";
import { cellText, displayText, hexLines, matchingLines, parseDelimited, previewKind, shortType, type PreviewKind } from "./parse";

const TEXT_CHUNK = 256 * 1024;
const HEX_CHUNK = 4096;
const PARQUET_ROWS = 100;

/** Loads an object piece by piece with ranged reads; nothing is fetched until asked for. */
function useChunks(at: ObjectAt, size: number, chunk: number) {
  const [bytes, setBytes] = useState(new Uint8Array());
  const { busy, error, run } = useAction();
  const more = async () => {
    if (bytes.length >= size) return;
    const got = await run(() => invoke<ArrayBuffer>("browse_read", { at, start: bytes.length, len: chunk }));
    if (!got) return;
    const next = new Uint8Array(bytes.length + got.byteLength);
    next.set(bytes);
    next.set(new Uint8Array(got), bytes.length);
    setBytes(next);
  };
  useEffect(() => {
    more();
  }, []);
  return { bytes, more, busy, error, complete: bytes.length >= size };
}

type Loaded = ReturnType<typeof useChunks>;

function LoadMore({ loaded, size, label }: { loaded: Loaded; size: number; label: string }) {
  return (
    <Stack direction="row" spacing={2} sx={{ alignItems: "center" }}>
      <Typography variant="body2" color="text.secondary">
        Đã tải {formatBytes(loaded.bytes.length)} / {formatBytes(size)}
        {loaded.complete ? " — đã tải hết." : "."}
      </Typography>
      {!loaded.complete && (
        <Button size="small" variant="outlined" onClick={loaded.more} disabled={loaded.busy}>
          {label}
        </Button>
      )}
    </Stack>
  );
}

function TextView({ at, size, kind }: { at: ObjectAt; size: number; kind: PreviewKind }) {
  const loaded = useChunks(at, size, TEXT_CHUNK);
  const [query, setQuery] = useState("");
  const [hit, setHit] = useState(0);
  const findRef = useRef<HTMLInputElement>(null);

  const lines = useMemo(
    () => displayText(kind, new TextDecoder().decode(loaded.bytes), loaded.complete).split("\n"),
    [loaded.bytes, loaded.complete],
  );
  const hits = useMemo(() => matchingLines(lines, query), [lines, query]);
  const current = hits.length ? hits[hit % hits.length] : undefined;
  const step = (by: number) => setHit((h) => (hits.length ? (h + by + hits.length) % hits.length : 0));

  useEffect(() => {
    // Ctrl-F goes to the viewer's own find box (the webview has no find bar).
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        findRef.current?.focus();
        findRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const widest = lines.reduce((n, l) => Math.max(n, l.length), 0);
  const columns: Column<string>[] = [
    { header: "#", width: "56px", align: "right", cell: (_, i) => i + 1 },
    {
      header: "Nội dung",
      width: "1fr",
      cell: (line) => (
        <Box component="span" sx={{ fontFamily: "monospace", whiteSpace: "pre" }}>
          {line}
        </Box>
      ),
    },
  ];
  return (
    <Stack spacing={1}>
      <Stack
        component="form"
        direction="row"
        spacing={1}
        sx={{ alignItems: "center" }}
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          step(1);
        }}
      >
        <TextField
          label="Tìm trong file (Ctrl-F)"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setHit(0);
          }}
          size="small"
          inputRef={findRef}
          sx={{ minWidth: 260 }}
        />
        <Typography variant="body2" aria-live="polite" sx={{ minWidth: 90 }}>
          {query ? (hits.length ? `${(hit % hits.length) + 1}/${hits.length} dòng` : "Không thấy") : ""}
        </Typography>
        <Button size="small" onClick={() => step(-1)} disabled={hits.length === 0}>
          Trước
        </Button>
        <Button size="small" type="submit" disabled={hits.length === 0}>
          Sau
        </Button>
      </Stack>
      {loaded.busy && <LinearProgress aria-label="Đang tải nội dung" />}
      <ErrorAlert error={loaded.error} />
      <VirtualTable
        columns={columns}
        rows={lines}
        height={440}
        rowHeight={24}
        minWidth={Math.min(60000, 90 + widest * 8.5)}
        focusRow={current}
        label="Nội dung file"
      />
      <LoadMore loaded={loaded} size={size} label="Tải thêm 256 KiB" />
      {!loaded.complete && (
        <Typography variant="body2" color="text.secondary">
          Tìm kiếm chỉ xét phần đã tải{kind === "json" ? "; JSON được format khi đã tải hết file." : "."}
        </Typography>
      )}
    </Stack>
  );
}

function CsvView({ at, size, delimiter }: { at: ObjectAt; size: number; delimiter: string }) {
  const loaded = useChunks(at, size, TEXT_CHUNK);
  const rows = useMemo(
    () => parseDelimited(new TextDecoder().decode(loaded.bytes), delimiter, loaded.complete),
    [loaded.bytes, loaded.complete],
  );
  const header = rows[0] ?? [];
  const data = rows.slice(1);
  const columns: Column<string[]>[] = [
    { header: "#", width: "56px", align: "right", cell: (_, i) => i + 1 },
    ...header.map((name, c) => ({
      header: name || `cột ${c + 1}`,
      width: "minmax(120px, 1fr)",
      cell: (row: string[]) => row[c] ?? "",
    })),
    {
      header: "Copy",
      width: "96px",
      cell: (row, i) => <CopyButton value={row.join(delimiter)} label={`Copy dòng ${i + 1}`} />,
    },
  ];
  return (
    <Stack spacing={1}>
      {loaded.busy && <LinearProgress aria-label="Đang tải nội dung" />}
      <ErrorAlert error={loaded.error} />
      <VirtualTable
        columns={columns}
        rows={data}
        height={440}
        minWidth={152 + header.length * 136}
        label="Bảng dữ liệu"
        empty={<Typography color="text.secondary">Chưa có dòng dữ liệu nào.</Typography>}
      />
      <Typography variant="body2" color="text.secondary">
        {data.length} dòng dữ liệu, {header.length} cột.
      </Typography>
      <LoadMore loaded={loaded} size={size} label="Tải thêm dòng" />
    </Stack>
  );
}

type ParquetPage = {
  columns: { name: string; data_type: string }[];
  total_rows: number;
  row_groups: number;
  offset: number;
  rows: Record<string, unknown>[];
  file_size: number;
  fetched_bytes: number;
  requests: number;
};

function ParquetView({ at }: { at: ObjectAt }) {
  const [page, setPage] = useState<ParquetPage | null>(null);
  const [goto, setGoto] = useState("");
  const { busy, error, run } = useAction();

  async function load(offset: number) {
    const loaded = await run(() => invoke<ParquetPage>("browse_parquet", { at, offset, limit: PARQUET_ROWS }));
    if (loaded) setPage(loaded);
  }
  useEffect(() => {
    load(0);
  }, []);

  const columns: Column<Record<string, unknown>>[] = page
    ? [
        { header: "#", width: "72px", align: "right", cell: (_, i) => page.offset + i + 1 },
        ...page.columns.map((c) => ({
          header: `${c.name} : ${shortType(c.data_type)}`,
          width: "minmax(150px, 1fr)",
          cell: (row: Record<string, unknown>) => {
            const text = cellText(row[c.name]);
            return (
              <Box component="span" title={text.slice(0, 600)} sx={{ fontFamily: "monospace", opacity: row[c.name] === null ? 0.5 : 1 }}>
                {text}
              </Box>
            );
          },
        })),
      ]
    : [];
  const last = page ? Math.max(0, page.total_rows - 1) : 0;
  const jump = (e: FormEvent) => {
    e.preventDefault();
    const row = Number(goto);
    if (/^\d+$/.test(goto) && row >= 1) load(Math.min(row - 1, last));
  };
  return (
    <Stack spacing={1}>
      {busy && <LinearProgress aria-label="Đang đọc Parquet" />}
      <ErrorAlert error={error} />
      {page && (
        <>
          <Stack component="form" onSubmit={jump} direction="row" spacing={1} sx={{ alignItems: "center" }}>
            <Button size="small" variant="outlined" disabled={busy || page.offset === 0} onClick={() => load(Math.max(0, page.offset - PARQUET_ROWS))}>
              Trang trước
            </Button>
            <Button
              size="small"
              variant="outlined"
              disabled={busy || page.offset + page.rows.length >= page.total_rows}
              onClick={() => load(page.offset + PARQUET_ROWS)}
            >
              Trang sau
            </Button>
            <TextField
              label="Tới dòng"
              value={goto}
              onChange={(e) => setGoto(e.target.value)}
              size="small"
              sx={{ width: 130 }}
              slotProps={{ htmlInput: { inputMode: "numeric" } }}
            />
            <Typography variant="body2" aria-live="polite">
              Dòng {page.rows.length ? page.offset + 1 : 0}–{page.offset + page.rows.length} / {page.total_rows}
            </Typography>
          </Stack>
          <VirtualTable
            columns={columns}
            rows={page.rows}
            height={400}
            minWidth={72 + page.columns.length * 166}
            label="Dữ liệu Parquet"
            empty={<Typography color="text.secondary">Không có dòng nào ở vị trí này.</Typography>}
          />
          <Typography variant="body2" color="text.secondary">
            {page.columns.length} cột, {page.row_groups} row group. Trang này tải {formatBytes(page.fetched_bytes)} qua{" "}
            {page.requests} range request; file {formatBytes(page.file_size)} không bị tải cả về.
          </Typography>
          <details>
            <summary>Schema ({page.columns.length} cột)</summary>
            <Box component="ul" sx={{ m: 0, fontFamily: "monospace", fontSize: 13 }}>
              {page.columns.map((c) => (
                <li key={c.name}>
                  {c.name}: {c.data_type}
                </li>
              ))}
            </Box>
          </details>
        </>
      )}
    </Stack>
  );
}

function HexView({ at, size }: { at: ObjectAt; size: number }) {
  const loaded = useChunks(at, size, HEX_CHUNK);
  const lines = useMemo(() => hexLines(loaded.bytes), [loaded.bytes]);
  return (
    <Stack spacing={1}>
      {loaded.busy && <LinearProgress aria-label="Đang tải nội dung" />}
      <ErrorAlert error={loaded.error} />
      <Box
        component="pre"
        aria-label="Hex dump"
        tabIndex={0}
        sx={{ m: 0, p: 2, bgcolor: "background.default", borderRadius: 1, overflow: "auto", maxHeight: 440, fontSize: 13 }}
      >
        {lines.join("\n")}
      </Box>
      <LoadMore loaded={loaded} size={size} label="Tải thêm 4 KiB" />
    </Stack>
  );
}

/** Image, audio, video and PDF are shown straight from a short-lived presigned URL, so the
 *  webview streams them from RGW itself (range requests) instead of through the app. */
function MediaView({ at, kind, name }: { at: ObjectAt; kind: PreviewKind; name: string }) {
  const [url, setUrl] = useState("");
  const [zoom, setZoom] = useState(0); // 0 = fit the panel, otherwise percent of the natural size
  const [natural, setNatural] = useState(0);
  const { busy, error, run } = useAction();
  useEffect(() => {
    run(() => invoke<string>("browse_media_url", { at })).then((u) => setUrl(u ?? ""));
  }, []);

  return (
    <Stack spacing={1}>
      {busy && <LinearProgress aria-label="Đang chuẩn bị" />}
      <ErrorAlert error={error} />
      {url && kind === "image" && (
        <>
          <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
            <Button size="small" variant="outlined" onClick={() => setZoom((z) => Math.max(10, (z || 100) / 1.5))} aria-label="Thu nhỏ">
              −
            </Button>
            <Button size="small" variant="outlined" onClick={() => setZoom((z) => Math.min(1600, (z || 100) * 1.5))} aria-label="Phóng to">
              +
            </Button>
            <Button size="small" onClick={() => setZoom(100)}>
              100%
            </Button>
            <Button size="small" onClick={() => setZoom(0)}>
              Vừa khung
            </Button>
            <Typography variant="body2" aria-live="polite">
              {zoom ? `${Math.round(zoom)}%` : "vừa khung"}
            </Typography>
          </Stack>
          <Box sx={{ overflow: "auto", maxHeight: 480, bgcolor: "background.default", borderRadius: 1 }}>
            <img
              src={url}
              alt={name}
              onLoad={(e) => setNatural(e.currentTarget.naturalWidth)}
              style={zoom && natural ? { width: (natural * zoom) / 100, display: "block" } : { maxWidth: "100%", display: "block" }}
            />
          </Box>
        </>
      )}
      {url && kind === "audio" && <audio controls src={url} aria-label={name} style={{ width: "100%" }} />}
      {url && kind === "video" && <video controls src={url} aria-label={name} style={{ maxWidth: "100%", maxHeight: 480 }} />}
      {url && kind === "pdf" && <iframe src={url} title={name} style={{ width: "100%", height: 560, border: 0, background: "#fff" }} />}
    </Stack>
  );
}

const KIND_LABEL: Record<PreviewKind, string> = {
  text: "văn bản",
  json: "JSON",
  csv: "CSV",
  tsv: "TSV",
  parquet: "Parquet",
  image: "ảnh",
  audio: "audio",
  video: "video",
  pdf: "PDF",
  hex: "hex",
};

export default function PreviewTab({ at, object }: ObjectTabProps) {
  const kind = previewKind(object.key);
  const [asHex, setAsHex] = useState(false);
  const shown = asHex ? "hex" : kind;
  if (object.size === 0) return <Alert severity="info">Object rỗng (0 byte), không có gì để xem.</Alert>;
  const name = object.key.slice(object.key.lastIndexOf("/") + 1);
  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={2} sx={{ alignItems: "center" }}>
        <Typography variant="body2" color="text.secondary" sx={{ flexGrow: 1 }}>
          Kiểu xem: {KIND_LABEL[shown]} · {formatBytes(object.size)}. Chỉ phần đang xem được tải về.
        </Typography>
        {kind !== "hex" && (
          <Button size="small" onClick={() => setAsHex(!asHex)}>
            {asHex ? `Xem dạng ${KIND_LABEL[kind]}` : "Xem dạng hex"}
          </Button>
        )}
      </Stack>
      {(shown === "text" || shown === "json") && <TextView at={at} size={object.size} kind={shown} />}
      {(shown === "csv" || shown === "tsv") && <CsvView at={at} size={object.size} delimiter={shown === "csv" ? "," : "\t"} />}
      {shown === "parquet" && <ParquetView at={at} />}
      {shown === "hex" && <HexView key="hex" at={at} size={object.size} />}
      {(shown === "image" || shown === "audio" || shown === "video" || shown === "pdf") && <MediaView at={at} kind={shown} name={name} />}
    </Stack>
  );
}
