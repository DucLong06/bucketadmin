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
import { invoke } from "./api";
import { t } from "./i18n";
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
          {at.uid ? t("inspect.headHintUser", { uid: at.uid }) : t("inspect.headHintMine")}
        </Typography>
        <Button size="small" onClick={load} disabled={busy}>
          {t("inspect.resend")}
        </Button>
      </Stack>
      {busy && <LinearProgress aria-label={t("inspect.sending")} />}
      <ErrorAlert error={error} />
      {inspected && (
        <Table size="small" aria-label={t("inspect.headers")}>
          <TableHead>
            <TableRow>
              <TableCell>{t("inspect.header")}</TableCell>
              <TableCell>{t("inspect.value")}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {inspected.headers.map(([name, value], i) => (
              <TableRow key={i}>
                <TableCell sx={{ whiteSpace: "nowrap" }}>{name}</TableCell>
                <TableCell sx={{ wordBreak: "break-all" }}>{value}</TableCell>
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
  if (tags.length > MAX_TAGS) return t("inspect.tooMany", { max: MAX_TAGS });
  const keys = tags.map((tag) => tag.key.trim());
  if (keys.some((k) => !k)) return t("inspect.noKey");
  if (new Set(keys).size !== keys.length) return t("inspect.dupKey");
  if (tags.some((tag) => tag.key.length > 128 || tag.value.length > 256)) return t("inspect.tooLong");
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
    setTags((list) => list.map((tag, n) => (n === i ? { ...tag, ...patch } : tag)));
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
      {busy && <LinearProgress aria-label={t("inspect.loadingTags")} />}
      <ErrorAlert error={error} />
      {stored && (
        <>
          {tags.length === 0 && <Typography color="text.secondary">{t("inspect.noTags")}</Typography>}
          <Stack spacing={1} component="ul" sx={{ listStyle: "none", p: 0, m: 0 }} aria-label={t("inspect.tagList")}>
            {tags.map((tag, i) => (
              <Stack key={i} component="li" direction="row" spacing={1} sx={{ alignItems: "center" }}>
                <TextField
                  label={t("inspect.tagKey")}
                  value={tag.key}
                  onChange={(e) => change(i, { key: e.target.value })}
                  size="small"
                  sx={{ width: 260 }}
                  slotProps={{ htmlInput: { "aria-label": t("inspect.tagKeyOf", { n: i + 1 }) } }}
                />
                <TextField
                  label={t("inspect.tagValue")}
                  value={tag.value}
                  onChange={(e) => change(i, { value: e.target.value })}
                  size="small"
                  sx={{ flexGrow: 1 }}
                  slotProps={{ htmlInput: { "aria-label": t("inspect.tagValueOf", { n: i + 1 }) } }}
                />
                <Button
                  size="small"
                  color="error"
                  onClick={() => {
                    setSaved(false);
                    setTags((list) => list.filter((_, n) => n !== i));
                  }}
                  aria-label={t("inspect.removeTagOf", { n: i + 1 })}
                >
                  {t("inspect.remove")}
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
                {t("inspect.addTag")}
              </Button>
              <Button variant="contained" onClick={save} disabled={busy || !dirty || !!problem}>
                {t("inspect.saveTags")}
              </Button>
              <Button onClick={load} disabled={busy}>
                {t("inspect.reload")}
              </Button>
            </Stack>
          </Box>
          {saved && <Alert severity="success">{t("inspect.saved")}</Alert>}
        </>
      )}
    </Stack>
  );
}
