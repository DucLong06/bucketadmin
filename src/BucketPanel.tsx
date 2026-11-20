import { type FormEvent, type Ref, useEffect, useRef, useState } from "react";
import { Alert, Box, Button, List, ListItemButton, ListItemText, Paper, Stack, TextField, Typography } from "@mui/material";
import type { BrowseBucket } from "./api";
import { t } from "./i18n";
import { splitPath } from "./paths";
import { eyebrow, tokens } from "./theme";

type Props = {
  /** Whose buckets these are, as the panel's heading. */
  title: string;
  buckets: BrowseBucket[];
  /** S3's error code when the key may not list buckets; a normal state for a key granted one folder. */
  bucketsError: string | null;
  /** The bucket that is open ("" for none). */
  current: string;
  /** Whether this panel's tab is the one on screen. */
  active: boolean;
  onOpen: (bucket: string, prefix: string) => void;
  onCreate: () => void;
  /** The Open-path field, so other parts of the page can send the user there. */
  pathRef?: Ref<HTMLInputElement>;
};

/** The sidebar's bucket card: the key's buckets, and a field that opens any path the key may use. */
export default function BucketPanel({ title, buckets, bucketsError, current, active, onOpen, onCreate, pathRef }: Props) {
  const [path, setPath] = useState("");
  const split = splitPath(path);
  const field = useRef<HTMLInputElement | null>(null);
  // A key that may not list buckets has one thing to do here: type the path it was given.
  useEffect(() => {
    if (bucketsError && active && !current) field.current?.focus();
  }, [bucketsError]);

  function openPath(e: FormEvent) {
    e.preventDefault();
    if (!split.error) onOpen(split.bucket, split.prefix);
  }
  return (
    <Paper variant="outlined" sx={{ borderRadius: "16px" }}>
      <Typography component="h2" sx={{ ...eyebrow, color: "text.secondary", px: 2, pt: 2 }}>
        {title}
      </Typography>
      <List dense aria-label={t("browse.bucketList")}>
        {buckets.map((b) => (
          <ListItemButton key={b.name} selected={b.name === current} onClick={() => onOpen(b.name, "")}>
            <ListItemText primary={b.name} slotProps={{ primary: { sx: { fontFamily: tokens.mono, fontSize: 15 } } }} />
          </ListItemButton>
        ))}
      </List>
      {bucketsError ? (
        <Alert severity="info" sx={{ mx: 1.5, mb: 1.5 }}>
          {t("browse.bucketsDenied")}
        </Alert>
      ) : (
        buckets.length === 0 && (
          <Typography variant="body2" color="text.secondary" sx={{ px: 2, pb: 1 }}>
            {t("browse.noBuckets")}
          </Typography>
        )
      )}
      <Box sx={{ px: 2, pb: 2 }}>
        <Button size="small" variant="outlined" fullWidth onClick={onCreate}>
          {t("browse.createBucket")}
        </Button>
      </Box>
      <Stack component="form" onSubmit={openPath} spacing={1} sx={{ p: 2, borderTop: 1, borderColor: "divider" }}>
        <TextField
          label={t("browse.openPath")}
          placeholder={t("browse.openPathSample")}
          value={path}
          onChange={(e) => setPath(e.target.value)}
          size="small"
          error={!!path.trim() && !!split.error}
          helperText={path.trim() && split.error ? t(split.error) : t("browse.openPathHelp")}
          inputRef={(input: HTMLInputElement | null) => {
            field.current = input;
            if (typeof pathRef === "function") pathRef(input);
            else if (pathRef) pathRef.current = input;
          }}
          slotProps={{ htmlInput: { style: { fontFamily: tokens.mono }, spellCheck: false } }}
        />
        <Button type="submit" size="small" variant="outlined" disabled={!!split.error}>
          {t("common.open")}
        </Button>
      </Stack>
    </Paper>
  );
}
