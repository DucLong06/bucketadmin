import { useEffect, useState } from "react";
import {
  Alert,
  AppBar,
  Button,
  Chip,
  Container,
  CssBaseline,
  Snackbar,
  Tab,
  Tabs,
  ThemeProvider,
  Toolbar,
  Typography,
  createTheme,
} from "@mui/material";
import { invoke, type Profile } from "./api";
import Audit from "./Audit";
import Browse from "./Browse";
import Buckets from "./Buckets";
import { accessLevel, LEVEL_LABEL, missingCaps, missingForFull, TAB_CAPS, type Access, type Level } from "./caps";
import Clusters from "./Clusters";
import { explain } from "./errors";
import { CallerContext, ErrorAlert } from "./ui";
import Users from "./Users";

const theme = createTheme({ palette: { mode: "dark" } });
/** A release whose tag is not this build's version (backend `update_check`). */
type Update = { tag: string; url: string; current: string };

export default function App() {
  const [page, setPage] = useState("users");
  // The user the Browse page works as; set from a user's drawer or typed on the page.
  const [browseUid, setBrowseUid] = useState("");
  const browseAs = (uid: string) => {
    setBrowseUid(uid);
    setPage("browse");
  };
  const [profiles, setProfiles] = useState<Profile[]>([]);
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
        setProfiles(list);
        // Keep the current cluster while it still exists, otherwise fall back to the first one.
        setClusterId((id) => (list.some((p) => p.id === id) ? id : (list[0]?.id ?? "")));
      })
      .catch((e) => setError(String(e)));
  useEffect(() => {
    reload();
  }, []);

  // What this cluster's key may do on the Admin API: asked once per cluster. A profile marked
  // "Tôi là user thường" is not asked at all: nothing of it ever goes to the Admin API.
  const plain = profiles.find((p) => p.id === clusterId)?.plain_user ?? false;
  const [access, setAccess] = useState<Access | null>(null);
  const [accessError, setAccessError] = useState<string | null>(null);
  useEffect(() => {
    setAccess(null);
    setAccessError(null);
    if (!clusterId || plain) return;
    let stale = false;
    invoke<Access>("caller_access", { clusterId }).then(
      (answer) => stale || setAccess(answer),
      // Unknown: every screen stays reachable and reports its own errors.
      (e) => stale || setAccessError(String(e)),
    );
    return () => {
      stale = true;
    };
  }, [clusterId, plain]);

  const level: Level | null = plain ? "browse" : access && accessLevel(access);
  // Caps an admin tab still lacks; an empty list means the tab works.
  const lacking = (tab: string) => (access && TAB_CAPS[tab] ? missingCaps(access, TAB_CAPS[tab]) : []);
  const blocked = (tab: string) => (plain && tab in TAB_CAPS) || lacking(tab).length > 0;
  useEffect(() => {
    if (blocked(page)) setPage("browse");
  }, [page, plain, access]);
  const adminTab = (value: string, label: string) => {
    const missing = lacking(value);
    return (
      <Tab
        value={value}
        label={label}
        aria-disabled={missing.length > 0}
        title={missing.length > 0 ? `Cần caps: ${missing.join(", ")}` : undefined}
        sx={missing.length > 0 ? { opacity: 0.45, cursor: "not-allowed" } : undefined}
      />
    );
  };
  const BADGE_COLOR = { admin: "success", partial: "warning", self: "info", browse: "default" } as const;
  const badgeHint = () => {
    if (plain) return "Profile này được đánh dấu \"Tôi là user thường\": app không gọi Admin API, chỉ dùng tab Browse.";
    if (!access || !level) return "";
    const missing = missingForFull(access);
    const who = `Key thuộc user ${access.uid}.`;
    return missing.length === 0 ? `${who} Đủ caps cho mọi tính năng.` : `${who} Còn thiếu caps: ${missing.join(", ")}.`;
  };

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <AppBar position="static" color="default">
        <Toolbar variant="dense">
          <Typography variant="h6" component="div" sx={{ mr: 4 }}>
            BucketAdmin
          </Typography>
          <Tabs
            value={page}
            onChange={(_, value) => blocked(value) || setPage(value)}
            aria-label="Điều hướng chính"
            sx={{ flexGrow: 1 }}
          >
            {!plain && adminTab("users", "Users")}
            {!plain && adminTab("buckets", "Buckets")}
            <Tab value="browse" label="Browse" />
            <Tab value="clusters" label="Clusters" />
            <Tab value="audit" label="Audit" />
          </Tabs>
          {update && (
            <Chip
              size="small"
              color="info"
              label={`Có bản mới ${update.tag}`}
              onClick={openRelease}
              title={`Đang dùng ${update.current}. Bấm để mở trang tải về: ${update.url}`}
              sx={{ mr: 1 }}
            />
          )}
          {level && <Chip size="small" color={BADGE_COLOR[level]} label={LEVEL_LABEL[level]} title={badgeHint()} aria-label={`Quyền của key: ${LEVEL_LABEL[level]}. ${badgeHint()}`} />}
          {accessError && <Chip size="small" color="error" variant="outlined" label="Chưa kiểm tra được caps" title={explain(accessError).message} />}
        </Toolbar>
      </AppBar>
      <CallerContext.Provider value={access?.uid ?? ""}>
        <Container maxWidth="lg" sx={{ py: 3 }}>
          <ErrorAlert error={error} />
          {page === "users" && (
            <Users profiles={profiles} clusterId={clusterId} onClusterChange={setClusterId} onBrowse={browseAs} />
          )}
          {page === "browse" && (
            <Browse
              profiles={profiles}
              clusterId={clusterId}
              onClusterChange={setClusterId}
              uid={browseUid}
              onUid={setBrowseUid}
              onProfilesChanged={reload}
              access={access}
              canBrowseAs={!plain && (access === null || access.users)}
            />
          )}
          {page === "buckets" && <Buckets profiles={profiles} clusterId={clusterId} onClusterChange={setClusterId} />}
          {page === "clusters" && <Clusters profiles={profiles} onChanged={reload} />}
          {page === "audit" && <Audit profiles={profiles} />}
        </Container>
      </CallerContext.Provider>
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
