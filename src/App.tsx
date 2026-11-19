import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  Container,
  CssBaseline,
  IconButton,
  Menu,
  MenuItem,
  Snackbar,
  Stack,
  Tab,
  Tabs,
  ThemeProvider,
  Typography,
} from "@mui/material";
import { invoke, type Profile } from "./api";
import Browse from "./Browse";
import Connections from "./Connections";
import { closeTab, cycleTab, placeLabel, samePlace, tabTitle, type BrowseTab, type Place } from "./tabs";
import { theme, tokens } from "./theme";
import { TaskPanel, useTransfers } from "./transfers";
import { ErrorAlert } from "./ui";

/** A release whose tag is not this build's version (backend `update_check`). */
type Update = { tag: string; url: string; current: string };

const newTab = (start: Place): BrowseTab => ({ id: crypto.randomUUID(), start, at: start });
const nowhere = (clusterId: string): Place => ({ clusterId, uid: "", bucket: "", prefix: "" });

export default function App() {
  const [page, setPage] = useState("browse");
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Browser-like tabs, each at its own place. All stay mounted, so a tab keeps its listing,
  // scroll position and selection while another one is on screen.
  const [tabs, setTabs] = useState<BrowseTab[]>([]);
  const [active, setActive] = useState("");
  const [recents, setRecents] = useState<Place[]>([]);
  const [recentMenu, setRecentMenu] = useState<HTMLElement | null>(null);
  // One task queue for every tab: a transfer keeps running when its tab is left or closed.
  const transfers = useTransfers();
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
    Promise.all([invoke<Profile[]>("list_profiles"), invoke<Place[]>("recent_list")])
      .then(([list, recent]) => {
        // Nothing to browse yet: start where a connection can be added.
        if (profiles === null && list.length === 0) setPage("connections");
        setProfiles(list);
        setRecents(recent);
        setTabs((old) => {
          if (old.length > 0) return old;
          const tab = newTab(nowhere(list[0]?.id ?? ""));
          setActive(tab.id);
          return [tab];
        });
      })
      .catch((e) => setError(String(e)));
  useEffect(() => {
    reload();
  }, []);

  function openTab(start: Place) {
    const tab = newTab(start);
    setTabs((old) => [...old, tab]);
    setActive(tab.id);
    setPage("browse");
  }
  const activeCluster = () => tabs.find((t) => t.id === active)?.at.clusterId ?? profiles?.[0]?.id ?? "";
  const openEmptyTab = () => openTab(nowhere(activeCluster()));
  function close(id: string) {
    const next = closeTab(tabs, active, id, newTab(nowhere(activeCluster())));
    setTabs(next.tabs);
    setActive(next.active);
  }
  // A place already open in a tab is shown there instead of being opened twice.
  function goTo(place: Place) {
    setRecentMenu(null);
    const open = tabs.find((t) => samePlace(t.at, place));
    if (!open) return openTab(place);
    setActive(open.id);
    setPage("browse");
  }
  const remember = (place: Place) => invoke<Place[]>("recent_add", { place }).then(setRecents, () => {});

  // Ctrl+T new tab, Ctrl+W close, Ctrl+Tab / Ctrl+Shift+Tab next / previous. The handler is
  // registered once and reads the current state through this ref.
  const keys = useRef({ openEmptyTab, close, tabs, active });
  keys.current = { openEmptyTab, close, tabs, active };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      // A dialog, drawer or menu belongs to the tab on screen: no switching underneath it.
      if (document.querySelector(".MuiDialog-root, .MuiDrawer-root, .MuiPopover-root")) return;
      const now = keys.current;
      const key = e.key.toLowerCase();
      if (key === "t") now.openEmptyTab();
      else if (key === "w") now.close(now.active);
      else if (key === "tab") {
        setActive(cycleTab(now.tabs, now.active, e.shiftKey ? -1 : 1));
        setPage("browse");
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const browsing = page === "browse";
  const known = recents.filter((r) => profiles?.some((p) => p.id === r.clusterId));
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box sx={{ display: "flex", flexDirection: "column", height: "100vh" }}>
        <Box component="header" sx={{ display: "flex", alignItems: "center", gap: 4.5, height: 64, px: 5, borderBottom: 1, borderColor: "divider", flexShrink: 0 }}>
          <Typography component="div" sx={{ fontFamily: tokens.serif, fontStyle: "italic", fontWeight: 600, fontSize: 24, letterSpacing: "-0.01em" }}>
            Bucket
            <Box component="span" sx={{ color: "primary.main", fontStyle: "normal" }}>
              Admin
            </Box>
          </Typography>
          <Tabs
            value={page}
            onChange={(_, value) => setPage(value)}
            aria-label="Điều hướng chính"
            textColor="inherit"
            sx={{ flexGrow: 1, alignSelf: "stretch", "& .MuiTabs-flexContainer": { height: "100%", gap: 2 } }}
          >
            <Tab value="browse" label="Browse" />
            <Tab value="connections" label="Kết nối" />
          </Tabs>
          {update && (
            <Chip
              variant="outlined"
              color="primary"
              label={`Có bản mới ${update.tag}`}
              onClick={openRelease}
              title={`Đang dùng ${update.current}. Bấm để mở trang tải về: ${update.url}`}
            />
          )}
        </Box>
        <Box sx={{ position: "relative", flexGrow: 1, minHeight: 0 }}>
          {/* The browse layer stays mounted (and keeps every tab's state) while Kết nối is shown. */}
          <Box sx={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", visibility: browsing ? "visible" : "hidden" }}>
            <Stack
              direction="row"
              role="tablist"
              aria-label="Các tab browse"
              sx={{ alignItems: "flex-end", gap: 0.75, px: 5, pt: 1.25, borderBottom: 1, borderColor: "divider", flexShrink: 0 }}
            >
              {tabs.map((t) => (
                <Box
                  key={t.id}
                  role="tab"
                  tabIndex={0}
                  aria-selected={t.id === active}
                  title={placeLabel(t.at, profiles ?? [])}
                  onClick={() => setActive(t.id)}
                  onKeyDown={(e) => e.key === "Enter" && setActive(t.id)}
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 0.5,
                    pl: 2,
                    pr: 0.75,
                    height: 38,
                    maxWidth: 240,
                    cursor: "pointer",
                    border: 1,
                    borderBottom: 0,
                    borderColor: t.id === active ? "primary.main" : "divider",
                    borderRadius: "14px 14px 0 0",
                    bgcolor: t.id === active ? "action.selected" : undefined,
                    color: t.id === active ? "text.primary" : "text.secondary",
                    fontWeight: t.id === active ? 600 : 400,
                  }}
                >
                  <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 14 }}>
                    {tabTitle(t.at)}
                  </Box>
                  <IconButton
                    size="small"
                    aria-label={`Đóng tab ${tabTitle(t.at)}`}
                    title="Đóng tab (Ctrl+W)"
                    onClick={(e) => {
                      e.stopPropagation();
                      close(t.id);
                    }}
                    sx={{ width: 24, height: 24, fontSize: 16 }}
                  >
                    ×
                  </IconButton>
                </Box>
              ))}
              <IconButton size="small" aria-label="Tab mới" title="Tab mới (Ctrl+T)" onClick={openEmptyTab} sx={{ width: 32, height: 32, mb: 0.375 }}>
                +
              </IconButton>
              <Box sx={{ flexGrow: 1 }} />
              <Button size="small" aria-haspopup="menu" onClick={(e) => setRecentMenu(e.currentTarget)} sx={{ mb: 0.5 }}>
                Gần đây
              </Button>
              <Menu anchorEl={recentMenu} open={recentMenu !== null} onClose={() => setRecentMenu(null)} slotProps={{ list: { "aria-label": "Vị trí mở gần đây (mở thành tab)" } }}>
                {known.length === 0 && <MenuItem disabled>Chưa có vị trí nào.</MenuItem>}
                {known.map((place) => (
                  <MenuItem key={JSON.stringify(place)} onClick={() => goTo(place)}>
                    {placeLabel(place, profiles ?? [])}
                  </MenuItem>
                ))}
              </Menu>
            </Stack>
            <Box sx={{ position: "relative", flexGrow: 1, minHeight: 0 }}>
              {profiles &&
                tabs.map((t) => {
                  const shown = browsing && t.id === active;
                  return (
                    // Hidden, not unmounted and not display:none: the tab keeps its state and its scroll position.
                    <Box key={t.id} role="tabpanel" aria-hidden={!shown} sx={{ position: "absolute", inset: 0, overflow: "auto", visibility: shown ? "visible" : "hidden" }}>
                      <Container maxWidth="xl" sx={{ py: 3, px: "40px !important" }}>
                        <Browse
                          profiles={profiles}
                          start={t.start}
                          active={shown}
                          startTransfer={transfers.start}
                          onPlace={(at) => setTabs((old) => old.map((tab) => (tab.id === t.id ? { ...tab, at } : tab)))}
                          remember={remember}
                          recents={known}
                          onRecent={goTo}
                        />
                      </Container>
                    </Box>
                  );
                })}
            </Box>
          </Box>
          {!browsing && (
            <Box sx={{ position: "absolute", inset: 0, overflow: "auto" }}>
              <Container maxWidth="lg" sx={{ py: 4, px: "40px !important" }}>
                <ErrorAlert error={error} />
                <Connections profiles={profiles ?? []} onChanged={reload} />
              </Container>
            </Box>
          )}
        </Box>
        <TaskPanel tasks={transfers} />
      </Box>
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
