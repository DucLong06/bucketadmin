import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Box, Button, LinearProgress, Stack, TextField, Typography } from "@mui/material";
import { invoke } from "../api";
import { formatBytes } from "../format";
import { getLang, t } from "../i18n";
import type { ObjectAt, ObjectTabProps } from "../ObjectDrawer";
import { getMode, palettes } from "../theme";
import { CopyButton, ErrorAlert, useAction } from "../ui";
import { VirtualTable, type Column } from "../virtual";
import {
  PREVIEW_CAP,
  cellText,
  displayText,
  hexLines,
  loadableBytes,
  matchingLines,
  parseDelimited,
  previewKind,
  previewPlan,
  shortType,
  type PreviewKind,
} from "./parse";

const TEXT_CHUNK = 256 * 1024;
const HEX_CHUNK = 4096;
const PARQUET_ROWS = 100;

/** Loads an object piece by piece with ranged reads; nothing is fetched until asked for. */
function useChunks(at: ObjectAt, size: number, chunk: number) {
  const [bytes, setBytes] = useState(new Uint8Array());
  const { busy, error, run } = useAction();
  const more = async () => {
    const len = Math.min(chunk, loadableBytes(bytes.length, size));
    if (len === 0) return;
    const got = await run(() => invoke<ArrayBuffer>("browse_read", { at, start: bytes.length, len }));
    if (!got) return;
    const next = new Uint8Array(bytes.length + got.byteLength);
    next.set(bytes);
    next.set(new Uint8Array(got), bytes.length);
    setBytes(next);
  };
  useEffect(() => {
    more();
  }, []);
  // `capped`: the viewer holds as much as it may, and the object has more.
  return { bytes, more, busy, error, complete: bytes.length >= size, capped: bytes.length < size && loadableBytes(bytes.length, size) === 0 };
}

type Loaded = ReturnType<typeof useChunks>;

function LoadMore({ loaded, size, label }: { loaded: Loaded; size: number; label: string }) {
  return (
    <Stack direction="row" spacing={2} sx={{ alignItems: "center" }}>
      <Typography variant="body2" color="text.secondary">
        {t(loaded.complete ? "preview.loadedAll" : "preview.loaded", { done: formatBytes(loaded.bytes.length), total: formatBytes(size) })}
      </Typography>
      {!loaded.complete && !loaded.capped && (
        <Button size="small" variant="outlined" onClick={loaded.more} disabled={loaded.busy}>
          {label}
        </Button>
      )}
      {loaded.capped && (
        <Typography variant="body2" color="warning.main">
          {t("preview.capped", { cap: formatBytes(PREVIEW_CAP) })}
        </Typography>
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
      header: t("preview.content"),
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
          label={t("preview.find")}
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
          {query ? (hits.length ? t("preview.hits", { at: (hit % hits.length) + 1, total: hits.length }) : t("preview.noHit")) : ""}
        </Typography>
        <Button size="small" onClick={() => step(-1)} disabled={hits.length === 0}>
          {t("preview.prev")}
        </Button>
        <Button size="small" type="submit" disabled={hits.length === 0}>
          {t("preview.next")}
        </Button>
      </Stack>
      {loaded.busy && <LinearProgress aria-label={t("preview.loading")} />}
      <ErrorAlert error={loaded.error} />
      <VirtualTable
        columns={columns}
        rows={lines}
        height={440}
        rowHeight={26}
        minWidth={Math.min(60000, 90 + widest * 9.1)}
        focusRow={current}
        label={t("preview.fileContent")}
      />
      <LoadMore loaded={loaded} size={size} label={t("preview.more256")} />
      {!loaded.complete && (
        <Typography variant="body2" color="text.secondary">
          {t(kind === "json" ? "preview.findPartialJson" : "preview.findPartial")}
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
      header: name || t("preview.column", { n: c + 1 }),
      width: "minmax(120px, 1fr)",
      cell: (row: string[]) => row[c] ?? "",
    })),
    {
      header: t("common.copy"),
      width: "96px",
      cell: (row, i) => <CopyButton value={row.join(delimiter)} label={t("preview.copyRow", { n: i + 1 })} />,
    },
  ];
  return (
    <Stack spacing={1}>
      {loaded.busy && <LinearProgress aria-label={t("preview.loading")} />}
      <ErrorAlert error={loaded.error} />
      <VirtualTable
        columns={columns}
        rows={data}
        height={440}
        minWidth={152 + header.length * 136}
        label={t("preview.table")}
        empty={<Typography color="text.secondary">{t("preview.noRows")}</Typography>}
      />
      <Typography variant="body2" color="text.secondary">
        {t("preview.csvCount", { rows: data.length, cols: header.length })}
      </Typography>
      <LoadMore loaded={loaded} size={size} label={t("preview.moreRows")} />
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
              <Box component="span" title={text.slice(0, 600)} sx={{ fontVariantNumeric: "tabular-nums", opacity: row[c.name] === null ? 0.5 : 1 }}>
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
      {busy && <LinearProgress aria-label={t("preview.readingParquet")} />}
      <ErrorAlert error={error} />
      {page && (
        <>
          <Stack component="form" onSubmit={jump} direction="row" spacing={1} sx={{ alignItems: "center" }}>
            <Button size="small" variant="outlined" disabled={busy || page.offset === 0} onClick={() => load(Math.max(0, page.offset - PARQUET_ROWS))}>
              {t("preview.prevPage")}
            </Button>
            <Button
              size="small"
              variant="outlined"
              disabled={busy || page.offset + page.rows.length >= page.total_rows}
              onClick={() => load(page.offset + PARQUET_ROWS)}
            >
              {t("preview.nextPage")}
            </Button>
            <TextField
              label={t("preview.goto")}
              value={goto}
              onChange={(e) => setGoto(e.target.value)}
              size="small"
              sx={{ width: 130 }}
              slotProps={{ htmlInput: { inputMode: "numeric" } }}
            />
            <Typography variant="body2" aria-live="polite">
              {t("preview.range", { from: page.rows.length ? page.offset + 1 : 0, to: page.offset + page.rows.length, total: page.total_rows })}
            </Typography>
          </Stack>
          <VirtualTable
            columns={columns}
            rows={page.rows}
            height={400}
            minWidth={72 + page.columns.length * 166}
            label={t("preview.parquetData")}
            empty={<Typography color="text.secondary">{t("preview.noRowsHere")}</Typography>}
          />
          <Typography variant="body2" color="text.secondary">
            {t("preview.parquetStats", {
              cols: page.columns.length,
              groups: page.row_groups,
              fetched: formatBytes(page.fetched_bytes),
              requests: page.requests,
              size: formatBytes(page.file_size),
            })}
          </Typography>
          <details>
            <summary>{t("preview.schema", { n: page.columns.length })}</summary>
            <Box component="ul" sx={{ m: 0, fontSize: 14 }}>
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
      {loaded.busy && <LinearProgress aria-label={t("preview.loading")} />}
      <ErrorAlert error={loaded.error} />
      <Box
        component="pre"
        aria-label={t("preview.hexDump")}
        tabIndex={0}
        sx={{ m: 0, p: 2, bgcolor: "background.default", borderRadius: 1, overflow: "auto", maxHeight: 440, fontSize: 14 }}
      >
        {lines.join("\n")}
      </Box>
      <LoadMore loaded={loaded} size={size} label={t("preview.more4k")} />
    </Stack>
  );
}

const FRAME_HEIGHT: Partial<Record<PreviewKind, number>> = { image: 480, audio: 64, video: 500, pdf: 560 };

/** Image, audio, video and PDF are shown by /preview.html in a frame: that page loads the
 *  object straight from RGW (a 15-minute presigned URL, so media streams by range requests)
 *  and is the only place in the app allowed to load anything remote. */
function MediaView({ at, kind, name }: { at: ObjectAt; kind: PreviewKind; name: string }) {
  const [url, setUrl] = useState("");
  const [zoom, setZoom] = useState(0); // 0 = fit the panel, otherwise percent of the natural size
  const frame = useRef<HTMLIFrameElement>(null);
  const { busy, error, run } = useAction();
  useEffect(() => {
    run(() => invoke<string>("browse_media_url", { at })).then((u) => setUrl(u ?? ""));
  }, []);
  const zoomTo = (percent: number) => {
    setZoom(percent);
    frame.current?.contentWindow?.postMessage({ zoom: percent }, "*");
  };

  return (
    <Stack spacing={1}>
      {busy && <LinearProgress aria-label={t("preview.preparing")} />}
      <ErrorAlert error={error} />
      {url && kind === "image" && (
        <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
          <Button size="small" variant="outlined" onClick={() => zoomTo(Math.max(10, (zoom || 100) / 1.5))} aria-label={t("preview.zoomOut")} title={t("preview.zoomOut")}>
            −
          </Button>
          <Button size="small" variant="outlined" onClick={() => zoomTo(Math.min(1600, (zoom || 100) * 1.5))} aria-label={t("preview.zoomIn")} title={t("preview.zoomIn")}>
            +
          </Button>
          <Button size="small" onClick={() => zoomTo(100)}>
            100%
          </Button>
          <Button size="small" onClick={() => zoomTo(0)}>
            {t("preview.fit")}
          </Button>
          <Typography variant="body2" aria-live="polite">
            {zoom ? `${Math.round(zoom)}%` : t("preview.fitState")}
          </Typography>
        </Stack>
      )}
      {url && (
        <iframe
          ref={frame}
          title={t("preview.frameTitle", { name })}
          // The frame is outside the bundle: the one sentence it can show comes along in its language, and the theme's colours with it.
          src={`/preview.html#${new URLSearchParams({ kind, url, name, lang: getLang(), fail: t("preview.unavailable"), bg: palettes[getMode()].bg, fg: palettes[getMode()].text })}`}
          style={{ width: "100%", height: FRAME_HEIGHT[kind], border: 0, borderRadius: 4 }}
        />
      )}
    </Stack>
  );
}

const kindLabel = (kind: PreviewKind) => t(`preview.kind.${kind}`);

export default function PreviewTab({ at, object }: ObjectTabProps) {
  const kind = previewKind(object.key);
  const [asHex, setAsHex] = useState(false);
  const [allowBig, setAllowBig] = useState(false);
  const shown = asHex ? "hex" : kind;
  const plan = previewPlan(shown, object.size);
  if (object.size === 0) return <Alert severity="info">{t("preview.empty")}</Alert>;
  const name = object.key.slice(object.key.lastIndexOf("/") + 1);
  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={2} sx={{ alignItems: "center" }}>
        <Typography variant="body2" color="text.secondary" sx={{ flexGrow: 1 }}>
          {t("preview.summary", { kind: kindLabel(shown), size: formatBytes(object.size) })}
        </Typography>
        {kind !== "hex" && (
          <Button size="small" onClick={() => setAsHex(!asHex)}>
            {t("preview.viewAs", { kind: kindLabel(asHex ? kind : "hex") })}
          </Button>
        )}
      </Stack>
      {(shown === "text" || shown === "json") && <TextView at={at} size={object.size} kind={shown} />}
      {(shown === "csv" || shown === "tsv") && <CsvView at={at} size={object.size} delimiter={shown === "csv" ? "," : "\t"} />}
      {shown === "parquet" && <ParquetView at={at} />}
      {shown === "hex" && <HexView key="hex" at={at} size={object.size} />}
      {plan === "prefix" && (
        <Alert severity="info">
          {t("preview.big", { size: formatBytes(object.size), cap: formatBytes(PREVIEW_CAP) })}
        </Alert>
      )}
      {plan === "ask" && !allowBig && (
        <Alert
          severity="warning"
          action={
            <Button color="inherit" size="small" onClick={() => setAllowBig(true)}>
              {t("preview.viewAnyway")}
            </Button>
          }
        >
          {t("preview.heavy", { kind: kindLabel(shown), size: formatBytes(object.size) })}
        </Alert>
      )}
      {(shown === "audio" || shown === "video" || ((shown === "image" || shown === "pdf") && (plan !== "ask" || allowBig))) && (
        <MediaView at={at} kind={shown} name={name} />
      )}
    </Stack>
  );
}
