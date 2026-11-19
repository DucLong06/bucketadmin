import { useEffect, useState } from "react";
import { Alert, AppBar, Button, Chip, Container, CssBaseline, Snackbar, Tab, Tabs, ThemeProvider, Toolbar, Typography, createTheme } from "@mui/material";
import { invoke, type Profile } from "./api";
import Browse from "./Browse";
import Connections from "./Connections";
import { ErrorAlert } from "./ui";

const theme = createTheme({ palette: { mode: "dark" } });
/** A release whose tag is not this build's version (backend `update_check`). */
type Update = { tag: string; url: string; current: string };

export default function App() {
  const [page, setPage] = useState("browse");
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [clusterId, setClusterId] = useState("");
  const [error, setError] = useState<string | null>(null);
  // A release newer than this build, found by the daily check; trouble checking is silent.
  const [update, setUpdate] = useState<Update | null>(null);
  const [updateToast, setUpdateToast] = useState<"new" | "no-browser" | null>(null);
  useEffect(() => {
    invoke<Update | null>("update_check").then(
      (found) => {
        setUpdate(found);
        if (found) setUpdateToast("new");
      },
      () => {},
    );
  }, []);
  const openRelease = () => invoke("update_open").then(() => setUpdateToast(null), () => setUpdateToast("no-browser"));

  const reload = () =>
    invoke<Profile[]>("list_profiles")
      .then((list) => {
        // Nothing to browse yet: start where a connection can be added.
        if (profiles === null && list.length === 0) setPage("connections");
        setProfiles(list);
        // Keep the current connection while it still exists, otherwise fall back to the first one.
        setClusterId((id) => (list.some((p) => p.id === id) ? id : (list[0]?.id ?? "")));
      })
      .catch((e) => setError(String(e)));
  useEffect(() => {
    reload();
  }, []);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <AppBar position="static" color="default">
        <Toolbar variant="dense">
          <Typography variant="h6" component="div" sx={{ mr: 4 }}>
            BucketAdmin
          </Typography>
          <Tabs value={page} onChange={(_, value) => setPage(value)} aria-label="Điều hướng chính" sx={{ flexGrow: 1 }}>
            <Tab value="browse" label="Browse" />
            <Tab value="connections" label="Kết nối" />
          </Tabs>
          {update && (
            <Chip
              size="small"
              color="info"
              label={`Có bản mới ${update.tag}`}
              onClick={openRelease}
              title={`Đang dùng ${update.current}. Bấm để mở trang tải về: ${update.url}`}
            />
          )}
        </Toolbar>
      </AppBar>
      <Container maxWidth="lg" sx={{ py: 3 }}>
        <ErrorAlert error={error} />
        {page === "browse" && profiles && <Browse profiles={profiles} clusterId={clusterId} onClusterChange={setClusterId} />}
        {page === "connections" && <Connections profiles={profiles ?? []} onChanged={reload} />}
      </Container>
      <Snackbar
        open={updateToast !== null}
        autoHideDuration={updateToast === "new" ? 12000 : null}
        onClose={(_, reason) => reason === "clickaway" || setUpdateToast(null)}
        anchorOrigin={{ vertical: "top", horizontal: "right" }}
      >
        <Alert
          severity="info"
          variant="filled"
          onClose={() => setUpdateToast(null)}
          action={
            updateToast === "new" && (
              <Button color="inherit" size="small" onClick={openRelease}>
                Mở trang tải về
              </Button>
            )
          }
          sx={{ wordBreak: "break-all" }}
        >
          {updateToast === "no-browser"
            ? `Không mở được trình duyệt. Trang tải về: ${update?.url}`
            : `Có bản mới ${update?.tag} (đang dùng ${update?.current}).`}
        </Alert>
      </Snackbar>
    </ThemeProvider>
  );
}
