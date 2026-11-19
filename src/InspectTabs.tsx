import { useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  LinearProgress,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import { invoke, keyOwner } from "./api";
import type { ObjectTabProps } from "./ObjectDrawer";
import { ErrorAlert, useAction } from "./ui";

export type Inspected = {
  head: { size: number; content_type: string; etag: string; last_modified: string; version_id: string | null };
  /** Every header of the HEAD response, as RGW sent them. */
  headers: [string, string][];
};
type Tag = { key: string; value: string };
const MAX_TAGS = 10;

/** The raw response headers of a real HEAD request for the object. */
export function HeadersTab({ at }: ObjectTabProps) {
  const [inspected, setInspected] = useState<Inspected | null>(null);
  const { busy, error, run } = useAction();
  const load = async () => {
    const loaded = await run(() => invoke<Inspected>("browse_inspect", { at }));
    setInspected(loaded ?? null);
  };
  useEffect(() => {
    load();
  }, []);

  return (
    <Stack spacing={2}>
      <Stack direction="row" spacing={2} sx={{ alignItems: "center" }}>
        <Typography variant="body2" color="text.secondary" sx={{ flexGrow: 1 }}>
          Header trả về từ một request HEAD thật tới RGW, ký bằng key của {keyOwner(at.uid)}.
        </Typography>
        <Button size="small" onClick={load} disabled={busy}>
          Gửi lại HEAD
        </Button>
      </Stack>
      {busy && <LinearProgress aria-label="Đang gửi HEAD" />}
      <ErrorAlert error={error} />
      {inspected && (
        <Table size="small" aria-label="Header của HEAD">
          <TableHead>
            <TableRow>
              <TableCell>Header</TableCell>
              <TableCell>Giá trị</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {inspected.headers.map(([name, value], i) => (
              <TableRow key={i}>
                <TableCell sx={{ fontFamily: "monospace", whiteSpace: "nowrap" }}>{name}</TableCell>
                <TableCell sx={{ fontFamily: "monospace", wordBreak: "break-all" }}>{value}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Stack>
  );
}

/** Why the tag list cannot be saved, or null. The backend checks the same rules. */
export function tagsError(tags: Tag[]): string | null {
  if (tags.length > MAX_TAGS) return `Mỗi object có tối đa ${MAX_TAGS} tag.`;
  const keys = tags.map((t) => t.key.trim());
  if (keys.some((k) => !k)) return "Có tag chưa có key.";
  if (new Set(keys).size !== keys.length) return "Có key bị trùng.";
  if (tags.some((t) => t.key.length > 128 || t.value.length > 256)) return "Key tối đa 128 ký tự, value tối đa 256 ký tự.";
  return null;
}

/** Object tagging: read, edit, replace. */
export function TagsTab({ at }: ObjectTabProps) {
  const [stored, setStored] = useState<Tag[] | null>(null);
  const [tags, setTags] = useState<Tag[]>([]);
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();

  const load = async () => {
    setSaved(false);
    const loaded = await run(() => invoke<Tag[]>("browse_tags_get", { at }));
    if (loaded) {
      setStored(loaded);
      setTags(loaded);
    }
  };
  useEffect(() => {
    load();
  }, []);

  const change = (i: number, patch: Partial<Tag>) => {
    setSaved(false);
    setTags((list) => list.map((t, n) => (n === i ? { ...t, ...patch } : t)));
  };
  async function save() {
    const done = await run(() => invoke("browse_tags_put", { at, tags }).then(() => true));
    if (done) {
      await load(); // show what RGW stored
      setSaved(true);
    }
  }

  const problem = tagsError(tags);
  const dirty = stored !== null && JSON.stringify(stored) !== JSON.stringify(tags);
  return (
    <Stack spacing={2}>
      {busy && <LinearProgress aria-label="Đang tải tag" />}
      <ErrorAlert error={error} />
      {stored && (
        <>
          {tags.length === 0 && <Typography color="text.secondary">Object chưa có tag nào.</Typography>}
          <Stack spacing={1} component="ul" sx={{ listStyle: "none", p: 0, m: 0 }} aria-label="Danh sách tag">
            {tags.map((tag, i) => (
              <Stack key={i} component="li" direction="row" spacing={1} sx={{ alignItems: "center" }}>
                <TextField
                  label="Key"
                  value={tag.key}
                  onChange={(e) => change(i, { key: e.target.value })}
                  size="small"
                  sx={{ width: 260 }}
                  slotProps={{ htmlInput: { "aria-label": `Key của tag ${i + 1}` } }}
                />
                <TextField
                  label="Value"
                  value={tag.value}
                  onChange={(e) => change(i, { value: e.target.value })}
                  size="small"
                  sx={{ flexGrow: 1 }}
                  slotProps={{ htmlInput: { "aria-label": `Value của tag ${i + 1}` } }}
                />
                <Button
                  size="small"
                  color="error"
                  onClick={() => {
                    setSaved(false);
                    setTags((list) => list.filter((_, n) => n !== i));
                  }}
                  aria-label={`Bỏ tag ${i + 1}`}
                >
                  Bỏ
                </Button>
              </Stack>
            ))}
          </Stack>
          {dirty && problem && <Alert severity="warning">{problem}</Alert>}
          <Box>
            <Stack direction="row" spacing={1}>
              <Button
                variant="outlined"
                disabled={tags.length >= MAX_TAGS}
                onClick={() => {
                  setSaved(false);
                  setTags((list) => [...list, { key: "", value: "" }]);
                }}
              >
                Thêm tag
              </Button>
              <Button variant="contained" onClick={save} disabled={busy || !dirty || !!problem}>
                Lưu tag
              </Button>
              <Button onClick={load} disabled={busy}>
                Đọc lại
              </Button>
            </Stack>
          </Box>
          {saved && <Alert severity="success">Đã lưu. Danh sách trên là tag đang có trên object.</Alert>}
        </>
      )}
    </Stack>
  );
}
