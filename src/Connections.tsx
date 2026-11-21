import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { Alert, Box, Button, Chip, Paper, Stack, TextField, Tooltip, Typography } from "@mui/material";
import { invoke, isInternal, maskKey, type EndpointKind, type Opened, type Profile, type Proxy } from "./api";
import { endpointError } from "./endpoint";
import { t, type Key } from "./i18n";
import { PathPicker } from "./PathPicker";
import { startPath } from "./paths";
import { ProxyPicker, proxyReady, sameProxy } from "./ProxyPicker";
import { ConfirmDialog, duplicateLabels, ErrorAlert, filterProfiles, LangToggle, SEARCH_ABOVE, ThemeSwitch } from "./ui";
import { stepScale, UI_SCALES } from "./zoom";

// Kept as data, not as text: what is on screen follows a change of language.
type Outcome = { severity: "error"; text: string } | { severity: "success"; key: Key; vars?: Record<string, string | number> };

/** `action`: what the success leads to (a button at the end of the notice). */
const outcomeAlert = (o: Outcome, sx?: object, action?: ReactNode) =>
  o.severity === "error" ? <ErrorAlert error={o.text} sx={sx} /> : <Alert severity={o.severity} sx={sx} action={action}>{t(o.key, o.vars)}</Alert>;

const emptyForm = { label: "", endpoint: "", accessKey: "", secretKey: "", startPath: "", adminAccessKey: "", adminSecretKey: "" };
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
/** One saved connection's start path: where its sessions land (for a key that may only list one folder). */
function ProfileStartPath({ profile, onChanged, fail }: { profile: Profile; onChanged: () => void; fail: (e: unknown) => void }) {
  const saved = profile.start_path ?? "";
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);
  const next = startPath(draft);
  return (
    <Stack direction="row" spacing={1} sx={{ mt: 1.5, alignItems: "flex-start" }}>
      {/* Asks nothing until it is typed in: every saved connection has one of these. */}
      <PathPicker clusterId={profile.id} lazy optional value={draft} onChange={setDraft} label={t("conn.startPath")} helperText={t("conn.startPathHelp")} ariaLabel={t("conn.startPathOf", { label: profile.label })} />
      <Button
        onClick={() => next.error || invoke("profile_set_start_path", { id: profile.id, startPath: next.path }).then(onChanged).catch(fail)}
        disabled={!!next.error || next.path === saved}
        aria-label={t("conn.saveStartPathFor", { label: profile.label })}
      >
        {t("conn.saveStartPath")}
      </Button>
    </Stack>
  );
}
// A key that is valid but may not list buckets is a working connection too: it opens the path it was given.
const connected = (opened: Pick<Opened, "buckets" | "buckets_error">): Outcome =>
  opened.buckets_error ? { severity: "success", key: "conn.okNoList" } : { severity: "success", key: "conn.ok", vars: { n: opened.buckets.length } };

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
  const urlError = form.endpoint ? endpointError(form.endpoint) : null;
  // The admin key is optional, but half of one is a mistake.
  const adminGiven = !!form.adminAccessKey.trim() || !!form.adminSecretKey;
  const adminReady = !adminGiven || (!!form.adminAccessKey.trim() && !!form.adminSecretKey);
  const canTest = !busy && !!form.endpoint && !urlError && !!form.accessKey && !!form.secretKey && proxyReady(formProxy);
  const start = startPath(form.startPath);
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
    const { endpoint, accessKey, secretKey } = form;
    try {
      setFormOutcome(connected(await invoke<Opened>("test_s3", { endpoint, accessKey, secretKey, proxy: formProxy })));
    } catch (e) {
      fail(e);
    }
    setTesting(false);
    setBusy(false);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { label, endpoint, accessKey, secretKey } = form;
    try {
      // The profile's own key is the one given first. With an admin key, that one is the
      // profile's key and "my key" is saved next to it as the key browse sessions sign with.
      const first = adminGiven ? { accessKey: form.adminAccessKey, secretKey: form.adminSecretKey } : { accessKey, secretKey };
      const saved = await invoke<Profile>("add_profile", { label, endpoint, ...first, startPath: start.error ? "" : start.path });
      setForm(emptyForm);
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

      <Paper component="form" onSubmit={save} variant="outlined" sx={{ p: 3, mb: 4 }}>
        <Typography variant="h6" component="h2" gutterBottom>
          {t("conn.add")}
        </Typography>
        <Stack spacing={2}>
          {/* Allowed, but said: the lists of the app show connections by label. */}
          {field("label", t("conn.label"), { required: true, color: labelTaken ? "warning" : undefined, focused: labelTaken || undefined, helperText: labelTaken ? t("conn.duplicateNew") : undefined })}
          {field("endpoint", t("conn.endpoint"), {
            required: true,
            placeholder: "http://host:7480",
            error: !!urlError,
            helperText: urlError ?? t("conn.endpointHelp"),
          })}
          {field("accessKey", t("conn.accessKey"), { required: true, autoComplete: "off", slotProps: keySx })}
          {field("secretKey", t("conn.secretKey"), {
            required: true,
            type: "password",
            autoComplete: "off",
            helperText: t("conn.secretHelp"),
          })}
          {/* No connection yet, so nothing to ask S3: the picker only checks the text. */}
          <PathPicker clusterId="" optional value={form.startPath} onChange={(startPath) => setForm({ ...form, startPath })} label={t("conn.startPath")} helperText={t("conn.startPathHelp")} />
          <details>
            <summary>{t("conn.adminKey")}</summary>
            <Stack spacing={2} sx={{ mt: 2 }}>
              <Typography variant="body2" color="text.secondary">
                {t("conn.adminHelp")}
              </Typography>
              {field("adminAccessKey", t("conn.adminAccessKey"), { autoComplete: "off", slotProps: keySx })}
              {field("adminSecretKey", t("conn.adminSecretKey"), {
                type: "password",
                autoComplete: "off",
                error: !adminReady,
                helperText: adminReady ? undefined : t("conn.adminHalf"),
              })}
            </Stack>
          </details>
          <ProxyPicker value={formProxy} onChange={setFormProxy} inherit name={t("proxy.name.new")} />
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
          <Stack direction="row" spacing={1}>
            <Button variant="outlined" onClick={testForm} disabled={!canTest}>
              {t(testing ? "conn.testing" : "conn.test")}
            </Button>
            <Button type="submit" variant="contained" disabled={!canTest || !adminReady || !!start.error || !form.label.trim()}>
              {t("common.save")}
            </Button>
          </Stack>
          {/* Saved: the next step is one click away. */}
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
      {profiles.length === 0 && <Typography color="text.secondary">{t("conn.none")}</Typography>}
      {profiles.length > 0 && listed.length === 0 && <Typography color="text.secondary">{t("conn.noMatch")}</Typography>}
      <Stack spacing={1.5} component="ul" sx={{ listStyle: "none", p: 0, m: 0 }}>
        {listed.map((p) => (
          <Paper key={p.id} component="li" variant="outlined" sx={{ p: 2.5 }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
              <Stack sx={{ flexGrow: 1, minWidth: 0 }}>
                <Typography sx={{ fontWeight: 600 }}>{p.label}</Typography>
                {isRepeated(p.label) && (
                  <Typography variant="caption" color="warning.main" role="note">
                    {t("conn.duplicateLabel")}
                  </Typography>
                )}
                <Typography variant="body2" color="text.secondary" noWrap>
                  <Mono>{p.endpoint}</Mono> · {t("conn.myKey")} <Mono>{maskKey(p.browse_access_key ?? p.access_key)}</Mono>
                  {p.browse_access_key && p.browse_access_key !== p.access_key && (
                    <>
                      {" "}
                      · {t("conn.adminKeyShort")} <Mono>{maskKey(p.access_key)}</Mono>
                    </>
                  )}
                </Typography>
              </Stack>
              <Button variant="outlined" onClick={() => onBrowse(p.id)} aria-label={t("conn.browseFor", { label: p.label })}>
                {t("conn.browse")}
              </Button>
              <Button onClick={() => testSaved(p.id)} disabled={testingRows.includes(p.id)} aria-label={t("conn.testFor", { label: p.label })}>
                {t(testingRows.includes(p.id) ? "conn.testing" : "conn.test")}
              </Button>
              <Button color="error" onClick={() => setRemoving(p)} aria-label={t("conn.remove", { label: p.label })}>
                {t("common.delete")}
              </Button>
            </Stack>
            <ProfileStartPath profile={p} onChanged={onChanged} fail={fail} />
            <ProfileProxy profile={p} onChanged={onChanged} fail={fail} />
            {rowOutcome[p.id] && outcomeAlert(rowOutcome[p.id], { mt: 1 })}
          </Paper>
        ))}
      </Stack>

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
