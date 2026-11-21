import { type FormEvent, type ReactNode, useContext, useEffect, useState } from "react";
import { Alert, Autocomplete, Box, Button, Chip, IconButton, Menu, MenuItem, Paper, Stack, TextField, Tooltip, Typography } from "@mui/material";
import { invoke, isInternal, maskKey, type EndpointKind, type Opened, type Profile, type Proxy } from "./api";
import { endpointError } from "./endpoint";
import { t, type Key } from "./i18n";
import { AccessContext, accessChips } from "./PathPicker";
import { addStartPath, startPath } from "./paths";
import { tokens } from "./theme";
import { ProxyPicker, proxyReady, sameProxy } from "./ProxyPicker";
import { ConfirmDialog, duplicateLabels, ErrorAlert, filterProfiles, FoldHeading, LangToggle, SEARCH_ABOVE, ThemeSwitch } from "./ui";
import { stepScale, UI_SCALES } from "./zoom";

// Kept as data, not as text: what is on screen follows a change of language.
type Outcome = { severity: "error"; text: string } | { severity: "success" | "warning"; key: Key; vars?: Record<string, string | number> };

/** The answer of a test or a save, shown where it was asked for: green, amber (connected, but the key may
 *  not list buckets) or red with S3's own code. `action`: what a success leads to (a button at the end). */
export const outcomeAlert = (o: Outcome, sx?: object, action?: ReactNode) =>
  o.severity === "error" ? <ErrorAlert error={o.text} sx={sx} /> : <Alert severity={o.severity} sx={sx} action={action}>{t(o.key, o.vars)}</Alert>;

// A new connection is almost always https: the scheme is there to type after.
// (`startPath`: what is typed into the start paths' field and not yet a chip; `startPaths`: the chips.)
const emptyForm = { label: "", endpoint: "https://", accessKey: "", secretKey: "", startPath: "", adminAccessKey: "", adminSecretKey: "" };
export type ConnectionForm = typeof emptyForm;
/** The four fields a connection cannot do without, in the order of the form. */
const REQUIRED: [keyof ConnectionForm, Key][] = [
  ["label", "conn.label"],
  ["endpoint", "conn.endpoint"],
  ["accessKey", "conn.accessKey"],
  ["secretKey", "conn.secretKey"],
];
/** Something was typed into the field (the prefilled scheme alone is nothing). */
const given = (form: ConnectionForm, key: keyof ConnectionForm) => !!form[key].trim() && !(key === "endpoint" && /^https?:\/\/$/.test(form[key].trim()));
/** Why the form cannot be saved yet, in the words of the Save button's tooltip: the first required field
 *  that is still empty, else the first thing that is wrong; null when it can be saved. */
export function saveBlocker(form: ConnectionForm): string | null {
  const missing = REQUIRED.find(([key]) => !given(form, key));
  if (missing) return t("conn.missing", { field: t(missing[1]) });
  // The admin key is optional, but half of one is a mistake.
  if (!!form.adminAccessKey.trim() !== !!form.adminSecretKey.trim()) return t("conn.adminHalf");
  const start = startPath(form.startPath);
  return endpointError(form.endpoint) ?? (start.error ? t(start.error) : null);
}
/** Whether the Advanced group of the form is open: remembered until the app is closed. */
const ADVANCED_OPEN = "ba.conn.advanced";
/** Host and port of an endpoint: what tells two connections apart at a glance (the whole URL is the tooltip). */
const hostOf = (endpoint: string) => {
  try {
    return new URL(endpoint).host || endpoint;
  } catch {
    return endpoint;
  }
};
/** Keys and paths are the one place the UI uses a monospace face. */
const Mono = ({ children }: { children: string }) => (
  <Box component="span" sx={{ fontFamily: "monospace" }}>
    {children}
  </Box>
);
const NO_PROXY: Proxy = { mode: "none" };

/** Asks the backend what the endpoint looks like; null while unknown, invalid or not asked. */
function useEndpointKind(endpoint: string, wanted: boolean): EndpointKind | null {
  const [kind, setKind] = useState<EndpointKind | null>(null);
  useEffect(() => {
    setKind(null);
    if (!wanted || !endpoint || endpointError(endpoint)) return;
    let stale = false;
    // Typing: wait for a pause before resolving the name.
    const timer = setTimeout(() => {
      invoke<EndpointKind>("endpoint_kind", { endpoint }).then(
        (answer) => stale || setKind(answer),
        () => {},
      );
    }, 400);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [endpoint, wanted]);
  return kind;
}

/** One saved connection's own proxy choice: saved with a button, with the "no proxy" hint for internal endpoints. */
function ProfileProxy({ profile, onChanged, fail }: { profile: Profile; onChanged: () => void; fail: (e: unknown) => void }) {
  const saved = profile.proxy ?? null;
  const [draft, setDraft] = useState<Proxy | null>(saved);
  useEffect(() => setDraft(saved), [JSON.stringify(saved)]);
  // Only a connection that may still go through a proxy needs the hint.
  const kind = useEndpointKind(profile.endpoint, saved === null || saved.mode === "auto");
  const save = (proxy: Proxy | null) => invoke("profile_set_proxy", { id: profile.id, proxy }).then(onChanged).catch(fail);
  return (
    <Stack spacing={1} sx={{ mt: 1 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
        <ProxyPicker value={draft} onChange={setDraft} inherit name={t("proxy.name.of", { label: profile.label })} />
        <Button onClick={() => save(draft)} disabled={sameProxy(draft, saved) || !proxyReady(draft)} aria-label={t("conn.saveProxyFor", { label: profile.label })}>
          {t("conn.saveProxy")}
        </Button>
      </Stack>
      {isInternal(kind) && (
        <Alert
          severity="info"
          action={
            <Button color="inherit" size="small" onClick={() => save(NO_PROXY)} aria-label={t("conn.noProxy.pickFor", { label: profile.label })}>
              {t("conn.noProxy.pick")}
            </Button>
          }
        >
          {t("conn.internalHint")}
        </Alert>
      )}
    </Stack>
  );
}
/** The chips after the chip input reports `next`: one fewer (a chip's ×, or Backspace), or one more, the
 *  text that was typed or picked, in its stored form. null: that text cannot be a path, nothing changes. */
export const chipsAfter = (chips: string[], next: string[]): string[] | null => {
  if (next.length <= chips.length) return next;
  const added = addStartPath(chips, next[next.length - 1]);
  return added.error ? null : added.paths;
};

type StartPathsProps = {
  /** The chips: start paths in their stored form. */
  value: string[];
  onChange: (paths: string[]) => void;
  /** What is typed and not yet a chip (saved with the chips all the same). */
  typed: string;
  onTyped: (text: string) => void;
  /** Accessible name of the input when the label alone does not tell fields apart. */
  ariaLabel?: string;
  /** Places to pick from (the connection's pinned and recent ones). */
  options?: string[];
};

/** The start paths of a connection as chips: Enter adds what is typed, × removes a chip. A text that
 *  cannot be a path is said under the field and stays text. */
export function StartPaths({ value, onChange, typed, onTyped, ariaLabel, options = [] }: StartPathsProps) {
  const wrong = startPath(typed).error;
  return (
    <Autocomplete
      multiple
      freeSolo
      fullWidth
      size="small"
      options={options}
      filterSelectedOptions
      value={value}
      inputValue={typed}
      // After Enter the field empties itself: not while what it holds was refused.
      onInputChange={(_, text, reason) => (reason === "reset" && wrong) || onTyped(text)}
      onChange={(_, next) => {
        const chips = chipsAfter(value, next);
        if (chips) onChange(chips);
      }}
      slotProps={{ chip: { sx: { fontFamily: tokens.mono, fontSize: 13.5 } } }}
      renderInput={(params) => (
        <TextField
          {...params}
          label={t("conn.startPath")}
          placeholder={value.length ? undefined : t("browse.openPathSample")}
          error={!!wrong}
          helperText={wrong ? t(wrong) : t("conn.startPathHelp")}
          slotProps={{ ...params.slotProps, inputLabel: { ...params.slotProps.inputLabel, shrink: true }, htmlInput: { ...params.slotProps.htmlInput, "aria-label": ariaLabel, spellCheck: false, style: { fontFamily: tokens.mono } } }}
        />
      )}
    />
  );
}

/** One saved connection's start paths: where its key works; its sessions land at the first. */
function ProfileStartPath({ profile, onChanged, fail }: { profile: Profile; onChanged: () => void; fail: (e: unknown) => void }) {
  const saved = profile.start_paths ?? [];
  const [draft, setDraft] = useState(saved);
  const [typed, setTyped] = useState("");
  useEffect(() => setDraft(saved), [saved.join("\n")]);
  const { pins, recents } = useContext(AccessContext);
  // What is still text counts as the last chip.
  const next = addStartPath(draft, typed);
  return (
    <Stack direction="row" spacing={1} sx={{ mt: 2, alignItems: "flex-start" }}>
      <StartPaths
        value={draft}
        onChange={setDraft}
        typed={typed}
        onTyped={setTyped}
        ariaLabel={t("conn.startPathOf", { label: profile.label })}
        options={accessChips({ pins, recents, policy: {} }, profile.id).map((chip) => chip.path)}
      />
      <Button
        onClick={() =>
          next.error ||
          invoke("profile_set_start_paths", { id: profile.id, startPaths: next.paths })
            .then(() => {
              setTyped("");
              onChanged();
            })
            .catch(fail)
        }
        disabled={!!next.error || next.paths.join("\n") === saved.join("\n")}
        aria-label={t("conn.saveStartPathFor", { label: profile.label })}
        sx={{ flexShrink: 0 }}
      >
        {t("conn.saveStartPath")}
      </Button>
    </Stack>
  );
}
// A key that is valid but may not list buckets is a working connection too: it opens the path it was given.
export const connected = (opened: Pick<Opened, "buckets" | "buckets_error">): Outcome =>
  opened.buckets_error ? { severity: "warning", key: "conn.okNoList" } : { severity: "success", key: "conn.ok", vars: { n: opened.buckets.length } };

/** The connections screen: the S3 endpoints the app browses, each with the user's own key
 *  (secret in the OS keychain), an optional admin key, and its proxy choice. */
type Props = {
  profiles: Profile[];
  onChanged: () => void;
  /** Size of the interface in percent, and how to ask for another one. */
  scale: number;
  onScale: (percent: number) => void;
  /** Go and browse a saved connection. */
  onBrowse: (id: string) => void;
};

export default function Connections({ profiles, onChanged, scale, onScale, onBrowse }: Props) {
  const [form, setForm] = useState(emptyForm);
  const [startPaths, setStartPaths] = useState<string[]>([]);
  // First run: a card with one button; the form comes when it is asked for.
  const [adding, setAdding] = useState(false);
  const [advanced, setAdvanced] = useState(() => globalThis.sessionStorage?.getItem(ADVANCED_OPEN) === "1");
  // The saved connection whose settings are open, and the one whose menu is.
  const [editing, setEditing] = useState("");
  const [menu, setMenu] = useState<{ anchor: HTMLElement; profile: Profile } | null>(null);
  // The new connection's own proxy choice; null = follow the app-wide setting.
  const [formProxy, setFormProxy] = useState<Proxy | null>(null);
  // The app-wide choice: as saved, and as being edited.
  const [network, setNetwork] = useState<Proxy>({ mode: "auto" });
  const [networkDraft, setNetworkDraft] = useState<Proxy>({ mode: "auto" });
  const [networkOutcome, setNetworkOutcome] = useState<Outcome | null>(null);
  useEffect(() => {
    invoke<Proxy>("network_get").then(
      (saved) => {
        setNetwork(saved);
        setNetworkDraft(saved);
      },
      (e) => setNetworkOutcome({ severity: "error", text: String(e) }),
    );
  }, []);
  async function saveNetwork() {
    try {
      const saved = await invoke<Proxy>("network_set", { proxy: networkDraft });
      setNetwork(saved);
      setNetworkDraft(saved);
      setNetworkOutcome({ severity: "success", key: "settings.networkSaved" });
    } catch (e) {
      setNetworkOutcome({ severity: "error", text: String(e) });
    }
  }
  const [formOutcome, setFormOutcome] = useState<Outcome | null>(null);
  const [rowOutcome, setRowOutcome] = useState<Record<string, Outcome>>({});
  const [busy, setBusy] = useState(false);
  // What the form is busy with: the button that was pressed says so.
  const [testing, setTesting] = useState(false);
  // Saved connections whose test is under way, the one saved a moment ago, and the one asked to be removed.
  const [testingRows, setTestingRows] = useState<string[]>([]);
  const [savedId, setSavedId] = useState("");
  const [removing, setRemoving] = useState<Profile | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  async function remove() {
    if (!removing) return;
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      await invoke("remove_profile", { id: removing.id });
      setRemoving(null);
      onChanged();
    } catch (e) {
      setRemoveError(String(e));
    }
    setRemoveBusy(false);
  }

  const fail = (e: unknown) => setFormOutcome({ severity: "error", text: String(e) });
  const urlError = given(form, "endpoint") ? endpointError(form.endpoint) : null;
  const adminGiven = !!form.adminAccessKey.trim() || !!form.adminSecretKey.trim();
  const adminReady = !!form.adminAccessKey.trim() === !!form.adminSecretKey.trim();
  const canTest = !busy && given(form, "endpoint") && !urlError && given(form, "accessKey") && given(form, "secretKey") && proxyReady(formProxy);
  const blocker = saveBlocker(form);
  // Keys are pasted: a space or a line break around one is never part of it.
  const keys = { accessKey: form.accessKey.trim(), secretKey: form.secretKey.trim() };
  const formKind = useEndpointKind(form.endpoint, formProxy === null || formProxy.mode === "auto");

  const field = (key: keyof typeof emptyForm, label: string, extra: object = {}) => (
    <TextField
      label={label}
      value={form[key]}
      onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      size="small"
      fullWidth
      {...extra}
    />
  );

  async function testForm() {
    setBusy(true);
    setTesting(true);
    setSavedId("");
    try {
      setFormOutcome(connected(await invoke<Opened>("test_s3", { endpoint: form.endpoint.trim(), ...keys, proxy: formProxy })));
    } catch (e) {
      fail(e);
    }
    setTesting(false);
    setBusy(false);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { label, endpoint } = form;
    const { accessKey, secretKey } = keys;
    try {
      // The profile's own key is the one given first. With an admin key, that one is the
      // profile's key and "my key" is saved next to it as the key browse sessions sign with.
      const first = adminGiven ? { accessKey: form.adminAccessKey.trim(), secretKey: form.adminSecretKey.trim() } : keys;
      // What is still text in the start paths' field counts as the last chip (Save is disabled while it cannot be one).
      const paths = addStartPath(startPaths, form.startPath);
      const saved = await invoke<Profile>("add_profile", { label, endpoint, ...first, startPaths: paths.error ? startPaths : paths.paths });
      setForm(emptyForm);
      setStartPaths([]);
      setFormProxy(null);
      // The connection exists from here on. If one of these fails, it is still listed and
      // the error says why: remove it and add it again.
      try {
        if (adminGiven) await invoke("browse_key_set", { clusterId: saved.id, accessKey, secretKey });
        if (formProxy) await invoke("profile_set_proxy", { id: saved.id, proxy: formProxy });
      } finally {
        onChanged();
      }
      setSavedId(saved.id);
      setFormOutcome({ severity: "success", key: "conn.saved", vars: { label: saved.label } });
    } catch (err) {
      fail(err);
    }
    setBusy(false);
  }

  async function testSaved(id: string) {
    setTestingRows((old) => [...old, id]);
    let outcome: Outcome;
    try {
      outcome = connected(await invoke<Opened>("browse_open", { clusterId: id, uid: "" }));
    } catch (e) {
      outcome = { severity: "error", text: String(e) };
    }
    setRowOutcome((prev) => ({ ...prev, [id]: outcome }));
    setTestingRows((old) => old.filter((other) => other !== id));
  }

  const keySx = { htmlInput: { style: { fontFamily: "monospace" } } };
  // Many connections: the list is searched; the search is not saved.
  const [search, setSearch] = useState("");
  const searchable = profiles.length > SEARCH_ABOVE;
  const listed = searchable ? filterProfiles(profiles, search) : profiles;
  const repeated = duplicateLabels(profiles);
  const isRepeated = (label: string) => repeated.has(label.trim().toLowerCase());
  const labelTaken = !!form.label.trim() && profiles.some((p) => p.label.trim().toLowerCase() === form.label.trim().toLowerCase());
  return (
    <>
      {/* The first screen a new user sees: the language can be chosen right here. */}
      <Stack direction="row" sx={{ alignItems: "flex-start", justifyContent: "space-between" }}>
        <Box>
          <Typography variant="overline" color="primary" component="p">
            {t("conn.title")}
          </Typography>
          <Typography variant="h4" component="h1" gutterBottom>
            {t("conn.title")}
          </Typography>
        </Box>
        <LangToggle />
      </Stack>
      <Typography color="text.secondary" sx={{ mb: 3, maxWidth: 720 }}>
        {t("conn.intro")}
      </Typography>

      {profiles.length === 0 && !adding ? (
        // First run: what is needed, and one button.
        <Paper variant="outlined" sx={{ p: 5, my: 4, mx: "auto", maxWidth: 520, textAlign: "center", borderRadius: "16px" }}>
          <Typography variant="h5" component="h2" gutterBottom>
            {t("conn.none")}
          </Typography>
          <Typography color="text.secondary" sx={{ mb: 3 }}>
            {t("conn.emptyText")}
          </Typography>
          <Button variant="contained" size="large" onClick={() => setAdding(true)}>
            {t("conn.add")}
          </Button>
        </Paper>
      ) : (
      <Paper component="form" onSubmit={save} variant="outlined" sx={{ p: 3, mb: 4 }}>
        <Typography variant="h6" component="h2" gutterBottom>
          {t("conn.add")}
        </Typography>
        <Stack spacing={2}>
          <Typography variant="overline" color="text.secondary" component="p" sx={{ mb: -1 }}>
            {t("conn.required")}
          </Typography>
          {/* Two columns where there is room for them; one below that. */}
          <Box sx={{ display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "repeat(2, minmax(0, 1fr))" }, gap: 2, alignItems: "start" }}>
            {/* Allowed, but said: the lists of the app show connections by label. */}
            {field("label", t("conn.label"), { required: true, autoFocus: adding, color: labelTaken ? "warning" : undefined, focused: labelTaken || undefined, helperText: labelTaken ? t("conn.duplicateNew") : t("conn.labelHelp") })}
            {field("endpoint", t("conn.endpoint"), {
              required: true,
              error: !!urlError,
              helperText: urlError ?? t("conn.endpointHelp"),
              slotProps: { htmlInput: { spellCheck: false } },
            })}
            {field("accessKey", t("conn.accessKey"), { required: true, autoComplete: "off", slotProps: keySx })}
            {field("secretKey", t("conn.secretKey"), {
              required: true,
              type: "password",
              autoComplete: "off",
              helperText: t("conn.secretHelp"),
            })}
          </Box>
          {isInternal(formKind) && (
            <Alert
              severity="info"
              action={
                <Button color="inherit" size="small" onClick={() => setFormProxy(NO_PROXY)}>
                  {t("conn.noProxy.pick")}
                </Button>
              }
            >
              {t("conn.internalHint")}
            </Alert>
          )}
          {/* What most connections never need: one click away, and it stays open once it was opened. */}
          <Box sx={{ border: 1, borderColor: "divider", borderRadius: "16px" }}>
            <FoldHeading
              title={t("conn.advanced")}
              open={advanced}
              controls="conn-advanced"
              onToggle={() => {
                globalThis.sessionStorage?.setItem(ADVANCED_OPEN, advanced ? "0" : "1");
                setAdvanced(!advanced);
              }}
            />
            {!advanced && (
              <Typography variant="body2" color="text.secondary" sx={{ px: 2, pb: 1.5, mt: -0.5 }}>
                {t("conn.advancedHint")}
              </Typography>
            )}
            {advanced && (
              <Stack id="conn-advanced" spacing={2} sx={{ px: 2, pb: 2 }}>
                <StartPaths value={startPaths} onChange={setStartPaths} typed={form.startPath} onTyped={(startPath) => setForm({ ...form, startPath })} />
                <Typography variant="body2" color="text.secondary">
                  <strong>{t("conn.adminKey")}</strong> — {t("conn.adminHelp")}
                </Typography>
                <Box sx={{ display: "grid", gridTemplateColumns: { xs: "minmax(0, 1fr)", md: "repeat(2, minmax(0, 1fr))" }, gap: 2, alignItems: "start" }}>
                  {field("adminAccessKey", t("conn.adminAccessKey"), { autoComplete: "off", slotProps: keySx })}
                  {field("adminSecretKey", t("conn.adminSecretKey"), {
                    type: "password",
                    autoComplete: "off",
                    error: !adminReady,
                    helperText: adminReady ? undefined : t("conn.adminHalf"),
                  })}
                </Box>
                <ProxyPicker value={formProxy} onChange={setFormProxy} inherit name={t("proxy.name.new")} />
              </Stack>
            )}
          </Box>
          <Stack direction="row" spacing={1} sx={{ alignItems: "center", flexWrap: "wrap" }} useFlexGap>
            <Button variant="outlined" onClick={testForm} disabled={!canTest}>
              {t(testing ? "conn.testing" : "conn.test")}
            </Button>
            {/* A disabled button says nothing by itself: the wrapper carries why. */}
            <span title={blocker ?? undefined}>
              <Button type="submit" variant="contained" disabled={busy || !!blocker || !proxyReady(formProxy)}>
                {t("common.save")}
              </Button>
            </span>
            {blocker && (
              <Typography variant="caption" color="text.secondary" role="status">
                {blocker}
              </Typography>
            )}
          </Stack>
          {/* The answer of the test stays here, in the form. Saved: the next step is one click away. */}
          {formOutcome &&
            outcomeAlert(
              formOutcome,
              undefined,
              formOutcome.severity === "success" && formOutcome.key === "conn.saved" && profiles.some((p) => p.id === savedId) && (
                <Button color="inherit" size="small" onClick={() => onBrowse(savedId)}>
                  {t("conn.browse")}
                </Button>
              ),
            )}
        </Stack>
      </Paper>
      )}

      {profiles.length > 0 && (
      <Stack direction="row" sx={{ alignItems: "center", gap: 1.5, mb: 1.5, flexWrap: "wrap" }}>
        <Typography variant="h6" component="h2">
          {t("conn.savedList")}
        </Typography>
        {profiles.length > 0 && (
          <Chip
            size="small"
            variant="outlined"
            aria-label={t("conn.countAria", { n: profiles.length })}
            label={searchable && search.trim() ? t("browse.filterCount", { n: listed.length, m: profiles.length }) : profiles.length}
            sx={{ fontVariantNumeric: "tabular-nums" }}
          />
        )}
        {searchable && (
          <TextField
            placeholder={t("conn.search")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setSearch("")}
            size="small"
            title={t("conn.searchHint")}
            slotProps={{ htmlInput: { "aria-label": t("conn.search"), spellCheck: false, type: "search" } }}
            sx={{ ml: "auto", width: 320, maxWidth: "100%" }}
          />
        )}
      </Stack>
      )}
      {profiles.length > 0 && listed.length === 0 && <Typography color="text.secondary">{t("conn.noMatch")}</Typography>}
      <Stack spacing={1.5} component="ul" sx={{ listStyle: "none", p: 0, m: 0 }}>
        {listed.map((p) => (
          <Paper key={p.id} component="li" variant="outlined" sx={{ p: 2.5 }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
              <Stack sx={{ flexGrow: 1, minWidth: 0 }}>
                <Typography noWrap title={p.label} sx={{ fontWeight: 600 }}>
                  {p.label}
                </Typography>
                {isRepeated(p.label) && (
                  <Typography variant="caption" color="warning.main" role="note">
                    {t("conn.duplicateLabel")}
                  </Typography>
                )}
                <Typography variant="body2" color="text.secondary" noWrap title={p.endpoint}>
                  <Mono>{hostOf(p.endpoint)}</Mono> · {t("conn.myKey")} <Mono>{maskKey(p.browse_access_key ?? p.access_key)}</Mono>
                  {p.browse_access_key && p.browse_access_key !== p.access_key && (
                    <>
                      {" "}
                      · {t("conn.adminKeyShort")} <Mono>{maskKey(p.access_key)}</Mono>
                    </>
                  )}
                </Typography>
                {!!p.start_paths?.length && (
                  <Typography variant="body2" color="text.secondary" noWrap title={p.start_paths.join("\n")}>
                    {t("conn.startsAt")} <Mono>{p.start_paths.join("  ·  ")}</Mono>
                  </Typography>
                )}
                {testingRows.includes(p.id) && (
                  <Typography variant="caption" color="text.secondary" role="status">
                    {t("conn.testing")}
                  </Typography>
                )}
              </Stack>
              <Button variant="contained" onClick={() => onBrowse(p.id)} aria-label={t("conn.browseFor", { label: p.label })} sx={{ flexShrink: 0 }}>
                {t("conn.browse")}
              </Button>
              <Button onClick={() => setEditing(editing === p.id ? "" : p.id)} aria-expanded={editing === p.id} aria-label={t("conn.editFor", { label: p.label })} sx={{ flexShrink: 0 }}>
                {t(editing === p.id ? "common.close" : "conn.edit")}
              </Button>
              <IconButton aria-label={t("conn.more", { label: p.label })} title={t("conn.more", { label: p.label })} aria-haspopup="menu" onClick={(e) => setMenu({ anchor: e.currentTarget, profile: p })} sx={{ width: 40, height: 40, flexShrink: 0 }}>
                ⋯
              </IconButton>
            </Stack>
            {editing === p.id && (
              <>
                <ProfileStartPath profile={p} onChanged={onChanged} fail={fail} />
                <ProfileProxy profile={p} onChanged={onChanged} fail={fail} />
              </>
            )}
            {rowOutcome[p.id] && outcomeAlert(rowOutcome[p.id], { mt: 1 })}
          </Paper>
        ))}
      </Stack>

      {/* The rest of what a saved connection can do: one menu, shared by the rows. */}
      <Menu anchorEl={menu?.anchor} open={menu !== null} onClose={() => setMenu(null)}>
        <MenuItem
          disabled={!!menu && testingRows.includes(menu.profile.id)}
          aria-label={menu ? t("conn.testFor", { label: menu.profile.label }) : undefined}
          onClick={() => {
            if (menu) testSaved(menu.profile.id);
            setMenu(null);
          }}
        >
          {t("conn.test")}
        </MenuItem>
        <MenuItem
          aria-label={menu ? t("conn.remove", { label: menu.profile.label }) : undefined}
          onClick={() => {
            setRemoving(menu?.profile ?? null);
            setMenu(null);
          }}
          sx={{ color: "error.main" }}
        >
          {t("common.delete")}
        </MenuItem>
      </Menu>

      <ConfirmDialog
        open={removing !== null}
        title={t("conn.removeTitle")}
        text={t("conn.removeText", { label: removing?.label ?? "" })}
        confirmLabel={t("conn.removeConfirm")}
        busy={removeBusy}
        error={removeError}
        onConfirm={remove}
        onClose={() => {
          setRemoving(null);
          setRemoveError(null);
        }}
      />

      <Paper variant="outlined" sx={{ p: 3, mt: 4 }}>
        <Typography variant="h6" component="h2" gutterBottom>
          {t("settings.network")}
        </Typography>
        <Stack spacing={2}>
          <Typography variant="body2" color="text.secondary">
            {t("settings.networkHelp")}
          </Typography>
          <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
            <ProxyPicker value={networkDraft} onChange={(next) => next && setNetworkDraft(next)} name={t("proxy.name.general")} />
            <Button variant="contained" onClick={saveNetwork} disabled={sameProxy(networkDraft, network) || !proxyReady(networkDraft)}>
              {t("settings.networkSave")}
            </Button>
          </Stack>
          {networkOutcome && outcomeAlert(networkOutcome)}
        </Stack>
      </Paper>

      <Paper variant="outlined" sx={{ p: 3, mt: 4 }}>
        <Typography variant="h6" component="h2" gutterBottom>
          {t("settings.display")}
        </Typography>
        <Stack direction="row" spacing={2} sx={{ alignItems: "center", flexWrap: "wrap" }} useFlexGap>
          <Typography variant="body2" color="text.secondary">
            {t("settings.size")}
          </Typography>
          <Tooltip title={t("settings.sizeTip")}>
            <Stack direction="row" spacing={0.5} role="group" aria-label={t("settings.size")} sx={{ alignItems: "center" }}>
              <Button variant="outlined" aria-label={t("settings.smaller")} disabled={scale <= UI_SCALES[0]} onClick={() => onScale(stepScale(scale, -1))}>
                A-
              </Button>
              <Typography aria-live="polite" sx={{ minWidth: 56, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>
                {scale}%
              </Typography>
              <Button variant="outlined" aria-label={t("settings.bigger")} disabled={scale >= UI_SCALES[UI_SCALES.length - 1]} onClick={() => onScale(stepScale(scale, 1))}>
                A+
              </Button>
            </Stack>
          </Tooltip>
          <Typography variant="body2" color="text.secondary" sx={{ ml: 3 }}>
            {t("settings.language")}
          </Typography>
          <LangToggle />
          <Box sx={{ ml: 3 }}>
            <ThemeSwitch />
          </Box>
        </Stack>
      </Paper>
    </>
  );
}
