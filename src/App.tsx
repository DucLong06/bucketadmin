import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  Container,
  CssBaseline,
  Divider,
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
import { explain } from "./errors";
import { AccessContext, PathPickerDialog } from "./PathPicker";
import { filterPins, isPinned, movePin, togglePin, type Pin, type PinOps } from "./pins";
import AuditLog from "./AuditLog";
import Browse, { NARROW, SHORT } from "./Browse";
import Connections from "./Connections";
import { t, useLang } from "./i18n";
import { closeTab, cycleTab, groupRecents, placeLabel, placePath, restoreTabs, samePlace, saveTabs, tabShortcut, tabTitle, type BrowseTab, type Place, type SavedTabs } from "./tabs";
import { eyebrow, setMode, themes, tokens, useMode } from "./theme";
import { TaskPanel, useTransfers } from "./transfers";
import { ErrorAlert, ListFilter, PinToggle } from "./ui";
import { zoomShortcut } from "./zoom";

/** A release newer than this build (backend `update_check`). */
type Update = { tag: string; url: string; current: string };

/** Pins the app-bar menu lists (the sidebar has them all). */
const PINS_IN_MENU = 15;
/** Above this many pins the menu starts with a field to type a part of a name or a path into. */
const PINS_MENU_FILTER_ABOVE = 8;
const newTab = (start: Place): BrowseTab => ({ id: crypto.randomUUID(), start, at: start });
const nowhere = (clusterId: string): Place => ({ clusterId, uid: "", bucket: "", prefix: "" });

export default function App() {
  // Every string below (and in every child) is looked up again when the language changes.
  useLang();
  const mode = useMode();
  // The app-bar menu: theme, audit log.
  const [appMenu, setAppMenu] = useState<HTMLElement | null>(null);
  const [page, setPage] = useState("browse");
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Browser-like tabs, each at its own place. All stay mounted, so a tab keeps its listing,
  // scroll position and selection while another one is on screen.
  const [tabs, setTabs] = useState<BrowseTab[]>([]);
  const [active, setActive] = useState("");
  const [recents, setRecents] = useState<Place[]>([]);
  const [recentMenu, setRecentMenu] = useState<HTMLElement | null>(null);
  // The other connections' recent places are folded away while the list is long.
  const [recentOthers, setRecentOthers] = useState(false);
  const tabBar = useRef<HTMLDivElement | null>(null);
  // The height the tab panes really have (the window less the app bar, the tab strip and the task panel),
  // as a CSS variable: the sidebar of a tab and its bucket list size themselves by it.
  const panes = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = panes.current;
    if (!el) return;
    const watch = new ResizeObserver(() => el.style.setProperty("--ba-pane-h", `${el.clientHeight}px`));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  // With many tabs the bar scrolls: the tab on screen is always in view.
  useEffect(() => {
    tabBar.current?.querySelector('[role=tab][aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, tabs.length]);
  // Pinned places, shared by every tab. A change shows at once; the saved list then replaces
  // the guess, and a refusal (the list is full) puts back what is really saved.
  const [pins, setPins] = useState<Pin[]>([]);
  const [pinMenu, setPinMenu] = useState<HTMLElement | null>(null);
  const [pinMenuFilter, setPinMenuFilter] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  // The connection a path is being pinned on, while the path picker is open for that.
  const [pinning, setPinning] = useState<string | null>(null);
  function savePins(guess: Pin[], command: string, args: Record<string, unknown>) {
    setPins(guess);
    invoke<Pin[]>(command, args).then(setPins, (e) => {
      setPinError(String(e));
      invoke<Pin[]>("pin_list").then(setPins, () => {});
    });
  }
  const pinOps: PinOps = {
    toggle: (place) => {
      if (!place.clusterId || !place.bucket) return;
      const guess = togglePin(pins, place, Math.floor(Date.now() / 1000));
      if (isPinned(pins, place)) savePins(guess, "pin_remove", { place });
      else savePins(guess, "pin_add", { place, label: "" });
    },
    rename: (place, label) => savePins(pins.map((pin) => (samePlace(pin.place, place) ? { ...pin, label } : pin)), "pin_rename", { place, label }),
    move: (place, to) => savePins(movePin(pins, place, to), "pin_move", { place, to }),
  };
  // Sidebar sections folded to their heading, shared by every tab and saved like the pins.
  const [folded, setFolded] = useState<string[]>([]);
  function fold(section: string, now: boolean) {
    setFolded((old) => [...old.filter((name) => name !== section), ...(now ? [section] : [])]);
    invoke<string[]>("folded_set", { section, folded: now }).then(setFolded, () => {});
  }
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
  // Size of the whole interface in percent. The backend zooms the webview and saves the choice.
  const [scale, setScale] = useState(100);
  useEffect(() => {
    invoke<number>("get_ui_scale").then(setScale, () => {});
  }, []);
  function zoomTo(percent: number) {
    // Shown and stepped from at once: a second key press must not start from the size before this one.
    keys.current.scale = percent;
    setScale(percent);
    // The backend answers with the size it saved; if it refused, show the size that is really in effect.
    invoke<number>("set_ui_scale", { percent }).then(setScale, () => invoke<number>("get_ui_scale").then(setScale, () => {}));
  }
  const openRelease = () => invoke("update_open").then(() => setUpdateToast(null), () => setUpdateToast("no-browser"));

  const reload = () =>
    // The saved tabs are a convenience: without them the app starts with its usual first tab.
    Promise.all([invoke<Profile[]>("list_profiles"), invoke<Place[]>("recent_list"), invoke<Pin[]>("pin_list"), invoke<SavedTabs | null>("tabs_get").catch(() => null), invoke<string[]>("folded_get").catch(() => [])])
      .then(([list, recent, pinned, saved, foldedNow]) => {
        setPins(pinned);
        setFolded(foldedNow);
        // Nothing to browse yet: start where a connection can be added.
        if (profiles === null && list.length === 0) setPage("connections");
        setProfiles(list);
        setRecents(recent);
        setTabs((old) => {
          if (old.length > 0) return old;
          // After a relaunch: the tabs that were open, each where it was.
          const again = restoreTabs(saved, list.map((p) => p.id));
          const tab = newTab(nowhere(list[0]?.id ?? ""));
          setActive(again?.active ?? tab.id);
          return again?.tabs ?? [tab];
        });
      })
      .catch((e) => setError(String(e)));
  useEffect(() => {
    reload();
  }, []);

  // Every change of the tabs is saved for the next start, once the changes pause.
  useEffect(() => {
    if (tabs.length === 0) return; // not loaded yet
    const timer = setTimeout(() => invoke("tabs_set", { tabs: saveTabs(tabs, active) }).catch(() => {}), 300);
    return () => clearTimeout(timer);
  }, [tabs, active]);

  function openTab(start: Place) {
    const tab = newTab(start);
    setTabs((old) => [...old, tab]);
    setActive(tab.id);
    setPage("browse");
  }
  // From the Connections screen: browse that connection. A tab with nothing open yet is reused.
  function browseConnection(clusterId: string) {
    const idle = tabs.find((tab) => tab.id === active && !tab.at.bucket);
    if (!idle) return openTab(nowhere(clusterId));
    const tab = newTab(nowhere(clusterId));
    setTabs((old) => old.map((other) => (other.id === idle.id ? tab : other)));
    setActive(tab.id);
    setPage("browse");
  }
  const activeCluster = () => tabs.find((tab) => tab.id === active)?.at.clusterId ?? profiles?.[0]?.id ?? "";
  const openEmptyTab = () => openTab(nowhere(activeCluster()));
  function close(id: string) {
    const next = closeTab(tabs, active, id, newTab(nowhere(activeCluster())));
    setTabs(next.tabs);
    setActive(next.active);
  }
  // A place already open in a tab is shown there instead of being opened twice.
  function goTo(place: Place) {
    setRecentMenu(null);
    setPinMenu(null);
    const open = tabs.find((tab) => samePlace(tab.at, place));
    if (!open) return openTab(place);
    setActive(open.id);
    setPage("browse");
  }
  const remember = (place: Place) => invoke<Place[]>("recent_add", { place }).then(setRecents, () => {});

  // Ctrl+T new tab, Ctrl+W close, Ctrl+Tab / Ctrl+Shift+Tab next / previous, Ctrl+D pin the place
  // of the tab on screen; Ctrl+= / Ctrl+- / Ctrl+0 zoom. The handler is registered once and reads
  // the current state through this ref.
  const keys = useRef({ openEmptyTab, close, tabs, active, scale, pinOps });
  keys.current = { openEmptyTab, close, tabs, active, scale, pinOps };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const now = keys.current;
      // Zoom works everywhere, also over a dialog.
      const size = zoomShortcut(e, now.scale);
      if (size !== null) {
        e.preventDefault();
        if (size !== now.scale) zoomTo(size);
        return;
      }
      const asked = tabShortcut(e);
      if (!asked) return;
      // Ctrl+D is the app's in every state (never the webview's own).
      if (asked === "pin") e.preventDefault();
      // A dialog, drawer or menu belongs to the tab on screen: no switching underneath it.
      if (document.querySelector(".MuiDialog-root, .MuiDrawer-root, .MuiPopover-root")) return;
      if (asked === "pin") {
        const here = now.tabs.find((tab) => tab.id === now.active)?.at;
        if (here?.bucket) now.pinOps.toggle(here);
        return;
      }
      if (asked === "new") now.openEmptyTab();
      else if (asked === "close") now.close(now.active);
      else {
        setActive(cycleTab(now.tabs, now.active, asked === "next" ? 1 : -1));
        setPage("browse");
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const browsing = page === "browse";
  const known = recents.filter((r) => profiles?.some((p) => p.id === r.clusterId));
  const knownPins = pins.filter((pin) => profiles?.some((p) => p.id === pin.place.clusterId));
  const pinMenuFilterable = knownPins.length > PINS_MENU_FILTER_ABOVE;
  const pinMenuRows = pinMenuFilterable ? filterPins(knownPins, pinMenuFilter) : knownPins;
  // The Recent menu, grouped like the pins: the connection of the tab on screen first.
  const recentGroups = groupRecents(known, activeCluster());
  const recentItem = (place: Place) => (
    <MenuItem key={JSON.stringify(place)} onClick={() => goTo(place)} sx={{ justifyContent: "space-between", gap: 2 }}>
      {placeLabel(place, profiles ?? [])}
      <PinToggle pinned={isPinned(pins, place)} label={t(isPinned(pins, place) ? "browse.unpinThis" : "browse.pinThis", { path: placePath(place) })} onToggle={() => pinOps.toggle(place)} />
    </MenuItem>
  );
  return (
    <ThemeProvider theme={themes[mode]}>
      <CssBaseline />
      <AccessContext.Provider value={{ profiles: profiles ?? [], pins: knownPins, recents: known }}>
      <Box sx={{ display: "flex", flexDirection: "column", height: "100vh" }}>
        <Box component="header" sx={{ display: "flex", alignItems: "center", gap: 4.5, height: 68, px: 5, borderBottom: 1, borderColor: "divider", flexShrink: 0, [NARROW]: { gap: 2, px: 2 }, [SHORT]: { height: 48 } }}>
          <Typography component="div" sx={{ fontFamily: tokens.serif, fontStyle: "italic", fontWeight: 600, fontSize: 25, letterSpacing: "-0.01em" }}>
            Bucket
            <Box component="span" sx={{ color: "primary.main", fontStyle: "normal" }}>
              Admin
            </Box>
          </Typography>
          <Tabs
            // The audit log is reached from the app-bar menu, not from a tab.
            value={page === "audit" ? false : page}
            onChange={(_, value) => setPage(value)}
            aria-label={t("app.nav")}
            textColor="inherit"
            sx={{ flexGrow: 1, alignSelf: "stretch", "& .MuiTabs-flexContainer": { height: "100%", gap: 2 } }}
          >
            <Tab value="browse" label={t("app.browse")} />
            <Tab value="connections" label={t("app.connections")} />
          </Tabs>
          {update && (
            <Chip
              variant="outlined"
              color="primary"
              label={t("app.update.badge", { tag: update.tag })}
              onClick={openRelease}
              title={t("app.update.title", { current: update.current, url: update.url })}
            />
          )}
          <Button size="small" variant="outlined" aria-haspopup="menu" onClick={(e) => setAppMenu(e.currentTarget)}>
            {t("app.menu")}
          </Button>
          <Menu anchorEl={appMenu} open={appMenu !== null} onClose={() => setAppMenu(null)} slotProps={{ list: { "aria-label": t("app.menu") } }}>
            <Typography component="li" role="presentation" sx={{ ...eyebrow, color: "text.secondary", px: 2, pt: 0.5, pb: 0.75 }}>
              {t("app.theme")}
            </Typography>
            {(["dark", "light"] as const).map((choice) => (
              <MenuItem key={choice} role="menuitemradio" aria-checked={mode === choice} selected={mode === choice} onClick={() => setMode(choice)} sx={{ minHeight: 40, gap: 1.25 }}>
                <Box component="span" aria-hidden sx={{ width: 10, height: 10, borderRadius: "50%", border: 2, borderColor: mode === choice ? "primary.main" : "divider", bgcolor: mode === choice ? "primary.main" : "transparent" }} />
                {t(`theme.${choice}`)}
              </MenuItem>
            ))}
            <Divider component="li" sx={{ my: 0.5 }} />
            <MenuItem
              selected={page === "audit"}
              onClick={() => {
                setAppMenu(null);
                setPage("audit");
              }}
              sx={{ minHeight: 40 }}
            >
              {t("app.audit")}
            </MenuItem>
          </Menu>
        </Box>
        <Box sx={{ position: "relative", flexGrow: 1, minHeight: 0 }}>
          {/* The browse layer stays mounted (and keeps every tab's state) while the connections screen is shown. */}
          <Box sx={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", visibility: browsing ? "visible" : "hidden" }}>
            <Stack direction="row" sx={{ alignItems: "flex-end", gap: 0.75, px: 5, pt: 1.25, borderBottom: 1, borderColor: "divider", flexShrink: 0, [NARROW]: { px: 2 }, [SHORT]: { pt: 0.5 } }}>
              {/* Tabs keep a readable width; when they do not fit, this strip scrolls (wheel, keyboard, or by itself to the active tab). */}
              <Stack
                direction="row"
                role="tablist"
                aria-label={t("app.tabs")}
                ref={tabBar}
                onWheel={(e) => (e.currentTarget.scrollLeft += e.deltaY)}
                sx={{ alignItems: "flex-end", gap: 0.75, minWidth: 0, overflowX: "auto", "&::-webkit-scrollbar": { display: "none" }, scrollbarWidth: "none" }}
              >
              {tabs.map((tab) => (
                <Box
                  key={tab.id}
                  role="tab"
                  tabIndex={0}
                  aria-selected={tab.id === active}
                  title={placeLabel(tab.at, profiles ?? [])}
                  onClick={() => setActive(tab.id)}
                  onKeyDown={(e) => {
                    // Like any tab or button: Enter and Space (only on the tab itself, not on its close button).
                    if ((e.key !== "Enter" && e.key !== " ") || e.target !== e.currentTarget) return;
                    e.preventDefault();
                    setActive(tab.id);
                  }}
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 0.5,
                    pl: 2,
                    pr: 0.75,
                    height: 42,
                    maxWidth: 256,
                    flexShrink: 0,
                    cursor: "pointer",
                    border: 1,
                    borderBottom: 0,
                    borderColor: tab.id === active ? "primary.main" : "divider",
                    borderRadius: "14px 14px 0 0",
                    bgcolor: tab.id === active ? "action.selected" : undefined,
                    color: tab.id === active ? "text.primary" : "text.secondary",
                    fontWeight: tab.id === active ? 600 : 400,
                  }}
                >
                  <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 15 }}>
                    {tabTitle(tab.at, profiles ?? [])}
                  </Box>
                  <IconButton
                    size="small"
                    aria-label={t("app.tab.close", { title: tabTitle(tab.at, profiles ?? []) })}
                    title={t("app.tab.closeTip")}
                    onClick={(e) => {
                      e.stopPropagation();
                      close(tab.id);
                    }}
                    // 28 px to look at, 40 × 40 to hit.
                    sx={{ width: 28, height: 28, fontSize: 17, "&::after": { content: '""', position: "absolute", inset: -6 } }}
                  >
                    ×
                  </IconButton>
                </Box>
              ))}
              </Stack>
              <IconButton size="small" aria-label={t("tabs.new")} title={t("app.tab.newTip")} onClick={openEmptyTab} sx={{ width: 40, height: 40, mb: 0.125, flexShrink: 0 }}>
                +
              </IconButton>
              <Box sx={{ flexGrow: 1 }} />
              <Button
                size="small"
                aria-haspopup="menu"
                onClick={(e) => {
                  setPinMenuFilter("");
                  setPinMenu(e.currentTarget);
                }}
                sx={{ mb: 0.5, flexShrink: 0 }}
              >
                {t("app.pinned")}
              </Button>
              {/* With the type-ahead field the keyboard starts in it, not on the first item. */}
              <Menu anchorEl={pinMenu} open={pinMenu !== null} onClose={() => setPinMenu(null)} autoFocus={!pinMenuFilterable} slotProps={{ list: { "aria-label": t("app.pinned.list") } }}>
                {pinMenuFilterable && (
                  // Typing is for the field (a menu would jump to the item that starts with the letter); Esc is the menu's.
                  <Box
                    component="li"
                    role="presentation"
                    sx={{ px: 1.5, pb: 1, minWidth: 300 }}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") return;
                      e.stopPropagation();
                      if (e.key !== "ArrowDown") return;
                      // The arrow down leaves the field for the first item (the menu itself would start from the item it had last).
                      e.preventDefault();
                      e.currentTarget.parentElement?.querySelector<HTMLElement>('[role=menuitem]:not([aria-disabled="true"])')?.focus();
                    }}
                  >
                    <ListFilter placeholder={t("pins.filter")} value={pinMenuFilter} onChange={setPinMenuFilter} shown={pinMenuRows.length} total={knownPins.length} autoFocus />
                  </Box>
                )}
                {pinMenuFilterable && pinMenuRows.length === 0 && (
                  <MenuItem disabled sx={{ whiteSpace: "normal", maxWidth: 340 }}>
                    {t("list.filterNone")}
                  </MenuItem>
                )}
                {knownPins.length === 0 && (
                  <MenuItem disabled sx={{ whiteSpace: "normal", maxWidth: 340 }}>
                    {t("app.pinned.none")}
                  </MenuItem>
                )}
                <MenuItem
                  disabled={!activeCluster()}
                  onClick={() => {
                    setPinMenu(null);
                    setPinning(activeCluster());
                  }}
                  sx={{ color: "primary.main" }}
                >
                  {t("pins.add")}
                </MenuItem>
                {pinMenuRows.slice(0, PINS_IN_MENU).map((pin) => (
                  <MenuItem key={JSON.stringify(pin.place)} title={placeLabel(pin.place, profiles ?? [])} onClick={() => goTo(pin.place)}>
                    {pin.label ? `${pin.label} · ${placeLabel(pin.place, profiles ?? [])}` : placeLabel(pin.place, profiles ?? [])}
                  </MenuItem>
                ))}
              </Menu>
              <Button
                size="small"
                aria-haspopup="menu"
                onClick={(e) => {
                  setRecentOthers(false);
                  setRecentMenu(e.currentTarget);
                }}
                sx={{ mb: 0.5, flexShrink: 0 }}
              >
                {t("app.recent")}
              </Button>
              <Menu anchorEl={recentMenu} open={recentMenu !== null} onClose={() => setRecentMenu(null)} slotProps={{ list: { "aria-label": t("app.recent.list") } }}>
                {known.length === 0 && <MenuItem disabled>{t("app.recent.none")}</MenuItem>}
                {recentGroups.here.map(recentItem)}
                {recentGroups.elsewhere.length > 0 &&
                  (recentGroups.collapsed && !recentOthers ? (
                    <MenuItem aria-expanded={false} onClick={() => setRecentOthers(true)} sx={{ color: "text.secondary" }}>
                      {t("recent.others", { n: recentGroups.elsewhere.length })}
                    </MenuItem>
                  ) : (
                    <Divider component="li" textAlign="left" sx={{ my: 0.5, fontSize: 12.5, color: "text.secondary" }}>
                      {t("browse.pinsElsewhere")}
                    </Divider>
                  ))}
                {(!recentGroups.collapsed || recentOthers) && recentGroups.elsewhere.map(recentItem)}
              </Menu>
            </Stack>
            <Box ref={panes} sx={{ position: "relative", flexGrow: 1, minHeight: 0 }}>
              {profiles &&
                tabs.map((tab) => {
                  const shown = browsing && tab.id === active;
                  return (
                    // Hidden, not unmounted and not display:none: the tab keeps its state and its scroll position.
                    <Box key={tab.id} role="tabpanel" aria-hidden={!shown} sx={{ position: "absolute", inset: 0, overflow: "auto", visibility: shown ? "visible" : "hidden" }}>
                      <Container maxWidth="xl" sx={{ py: 3, px: "40px !important", [NARROW]: { px: "16px !important" }, [SHORT]: { py: 1.5 } }}>
                        <Browse
                          profiles={profiles}
                          start={tab.start}
                          active={shown}
                          startTransfer={transfers.start}
                          onPlace={(at) => setTabs((old) => old.map((other) => (other.id === tab.id ? { ...other, at } : other)))}
                          remember={remember}
                          recents={known}
                          onRecent={goTo}
                          pins={knownPins}
                          pinOps={pinOps}
                          onOpenTab={openTab}
                          onPinPath={setPinning}
                          folded={folded}
                          onFold={fold}
                        />
                      </Container>
                    </Box>
                  );
                })}
            </Box>
          </Box>
          {!browsing && (
            <Box sx={{ position: "absolute", inset: 0, overflow: "auto" }}>
              <Container maxWidth="lg" sx={{ py: 4, px: "40px !important", [NARROW]: { px: "16px !important" }, [SHORT]: { py: 2 } }}>
                <ErrorAlert error={error} />
                {page === "audit" ? <AuditLog /> : <Connections profiles={profiles ?? []} onChanged={reload} scale={scale} onScale={zoomTo} onBrowse={browseConnection} />}
              </Container>
            </Box>
          )}
        </Box>
        <TaskPanel tasks={transfers} />
      </Box>
      <PathPickerDialog
        open={pinning !== null}
        title={t("pins.addTitle")}
        submitLabel={t("pins.addSubmit")}
        clusterId={pinning ?? ""}
        onSubmit={(bucket, prefix) => {
          const place = { clusterId: pinning ?? "", uid: "", bucket, prefix };
          if (!isPinned(pins, place)) pinOps.toggle(place);
        }}
        onClose={() => setPinning(null)}
      />
      </AccessContext.Provider>
      <Snackbar open={pinError !== null} autoHideDuration={8000} onClose={() => setPinError(null)} anchorOrigin={{ vertical: "bottom", horizontal: "center" }}>
        <Alert severity="error" variant="filled" onClose={() => setPinError(null)}>
          {pinError ? explain(pinError).message : ""}
        </Alert>
      </Snackbar>
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
                {t("app.update.open")}
              </Button>
            )
          }
          sx={{ wordBreak: "break-all" }}
        >
          {updateToast === "no-browser"
            ? t("app.update.noBrowser", { url: update?.url ?? "" })
            : t("app.update.toast", { tag: update?.tag ?? "", current: update?.current ?? "" })}
        </Alert>
      </Snackbar>
    </ThemeProvider>
  );
}
