import { type FormEvent, useEffect, useState } from "react";
import { Alert, Button, Checkbox, FormControlLabel, Paper, Stack, TextField, Typography } from "@mui/material";
import { invoke, isInternal, maskKey, type ClusterInfo, type EndpointKind, type Profile, type Proxy } from "./api";
import { endpointError } from "./endpoint";
import { ProxyPicker, proxyReady, sameProxy } from "./ProxyPicker";
import { ErrorAlert } from "./ui";

type Outcome = { severity: "success" | "warning" | "error"; text: string };

const outcomeAlert = (o: Outcome, sx?: object) =>
  o.severity === "error" ? <ErrorAlert error={o.text} sx={sx} /> : <Alert severity={o.severity} sx={sx}>{o.text}</Alert>;

const emptyForm = { label: "", endpoint: "", accessKey: "", secretKey: "" };
const NO_PROXY: Proxy = { mode: "none" };
const INTERNAL_HINT =
  'Endpoint này nằm trong mạng nội bộ (địa chỉ private hoặc tên chỉ DNS nội bộ biết): proxy thường không tới được. Nên chọn "Không dùng proxy".';

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

/** One saved cluster's own proxy choice: saved with a button, with the "no proxy" hint for internal endpoints. */
function ProfileProxy({ profile, onChanged, fail }: { profile: Profile; onChanged: () => void; fail: (e: unknown) => void }) {
  const saved = profile.proxy ?? null;
  const [draft, setDraft] = useState<Proxy | null>(saved);
  useEffect(() => setDraft(saved), [JSON.stringify(saved)]);
  // Only a cluster that may still go through a proxy needs the hint.
  const kind = useEndpointKind(profile.endpoint, saved === null || saved.mode === "auto");
  const save = (proxy: Proxy | null) => invoke("profile_set_proxy", { id: profile.id, proxy }).then(onChanged).catch(fail);
  return (
    <Stack spacing={1} sx={{ mt: 1 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
        <ProxyPicker value={draft} onChange={setDraft} inherit name={`của ${profile.label}`} />
        <Button onClick={() => save(draft)} disabled={sameProxy(draft, saved) || !proxyReady(draft)} aria-label={`Lưu proxy của ${profile.label}`}>
          Lưu proxy
        </Button>
      </Stack>
      {isInternal(kind) && (
        <Alert
          severity="info"
          action={
            <Button color="inherit" size="small" onClick={() => save(NO_PROXY)} aria-label={`Chọn Không dùng proxy cho ${profile.label}`}>
              Chọn Không dùng proxy
            </Button>
          }
        >
          {INTERNAL_HINT}
        </Alert>
      )}
    </Stack>
  );
}
const PLAIN_LABEL = "Tôi là user thường (key không có caps admin): ẩn các tab admin, chỉ dùng Browse";

async function testOutcome(call: Promise<ClusterInfo>): Promise<Outcome> {
  try {
    const info = await call;
    return {
      severity: "success",
      text: `Kết nối thành công. cluster_id: ${info.cluster_id} · version: ${info.version ?? "không rõ"}`,
    };
  } catch (e) {
    const text = String(e);
    // RGW checks the signature before the caps: a refusal for caps means the key itself is good.
    if (text.startsWith("AccessDenied (403)")) {
      return {
        severity: "warning",
        text: "Endpoint trả lời và key hợp lệ, nhưng key này không có caps admin (info=read). Tab Browse vẫn dùng được bằng chính key này; nếu bạn là user thường, hãy tick \"Tôi là user thường\".",
      };
    }
    return { severity: "error", text };
  }
}

export default function Clusters({ profiles, onChanged }: { profiles: Profile[]; onChanged: () => void }) {
  const [form, setForm] = useState(emptyForm);
  const [plain, setPlain] = useState(false);
  // The new cluster's own proxy choice; null = follow the app-wide setting.
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
      setNetworkOutcome({ severity: "success", text: "Đã lưu. Áp dụng cho mọi cluster không có lựa chọn proxy riêng, và cho việc kiểm tra bản mới." });
    } catch (e) {
      setNetworkOutcome({ severity: "error", text: String(e) });
    }
  }
  const [formOutcome, setFormOutcome] = useState<Outcome | null>(null);
  const [rowOutcome, setRowOutcome] = useState<Record<string, Outcome>>({});
  const [busy, setBusy] = useState(false);

  const fail = (e: unknown) => setFormOutcome({ severity: "error", text: String(e) });
  const urlError = form.endpoint ? endpointError(form.endpoint) : null;
  const canTest = !busy && !!form.endpoint && !urlError && !!form.accessKey && !!form.secretKey && proxyReady(formProxy);
  const formKind = useEndpointKind(form.endpoint, formProxy === null || formProxy.mode === "auto");

  const field = (key: keyof typeof emptyForm, label: string, extra: object = {}) => (
    <TextField
      label={label}
      value={form[key]}
      onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      size="small"
      fullWidth
      required
      {...extra}
    />
  );

  async function testForm() {
    setBusy(true);
    const { endpoint, accessKey, secretKey } = form;
    setFormOutcome(await testOutcome(invoke("test_connection", { endpoint, accessKey, secretKey, proxy: formProxy })));
    setBusy(false);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const saved = await invoke<Profile>("add_profile", form);
      setForm(emptyForm);
      setPlain(false);
      setFormProxy(null);
      // The profile exists from here on. If one of these fails, it is still listed (without
      // the option) and the error says why; its row offers the same options again.
      try {
        if (formProxy) await invoke("profile_set_proxy", { id: saved.id, proxy: formProxy });
        if (plain) await invoke("profile_set_plain", { id: saved.id, plain: true });
      } finally {
        onChanged();
      }
      setFormOutcome({
        severity: "success",
        text: `Đã lưu "${saved.label}". Secret key được cất trong keychain của hệ thống.`,
      });
    } catch (err) {
      fail(err);
    }
    setBusy(false);
  }

  async function testSaved(id: string) {
    const outcome = await testOutcome(invoke("test_profile", { id }));
    setRowOutcome((prev) => ({ ...prev, [id]: outcome }));
  }

  return (
    <>
      <Typography variant="h5" component="h1" gutterBottom>
        Clusters
      </Typography>

      <Paper component="form" onSubmit={save} variant="outlined" sx={{ p: 2, mb: 3 }}>
        <Typography variant="h6" component="h2" gutterBottom>
          Thêm cluster
        </Typography>
        <Stack spacing={2}>
          {field("label", "Tên hiển thị")}
          {field("endpoint", "Endpoint", {
            placeholder: "http://host:7480",
            error: !!urlError,
            helperText: urlError ?? "Địa chỉ RGW, ví dụ http://host:7480",
          })}
          {field("accessKey", "Access key", { autoComplete: "off" })}
          {field("secretKey", "Secret key", { type: "password", autoComplete: "off" })}
          <FormControlLabel control={<Checkbox checked={plain} onChange={(e) => setPlain(e.target.checked)} />} label={PLAIN_LABEL} />
          <ProxyPicker value={formProxy} onChange={setFormProxy} inherit name="của cluster mới" />
          {isInternal(formKind) && (
            <Alert
              severity="info"
              action={
                <Button color="inherit" size="small" onClick={() => setFormProxy(NO_PROXY)}>
                  Chọn Không dùng proxy
                </Button>
              }
            >
              {INTERNAL_HINT}
            </Alert>
          )}
          <Stack direction="row" spacing={1}>
            <Button variant="outlined" onClick={testForm} disabled={!canTest}>
              Kiểm tra kết nối
            </Button>
            <Button type="submit" variant="contained" disabled={!canTest || !form.label.trim()}>
              Lưu
            </Button>
          </Stack>
          {formOutcome && outcomeAlert(formOutcome)}
        </Stack>
      </Paper>

      <Typography variant="h6" component="h2" gutterBottom>
        Cluster đã lưu
      </Typography>
      {profiles.length === 0 && <Typography color="text.secondary">Chưa có cluster nào.</Typography>}
      <Stack spacing={1} component="ul" sx={{ listStyle: "none", p: 0, m: 0 }}>
        {profiles.map((p) => (
          <Paper key={p.id} component="li" variant="outlined" sx={{ p: 2 }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
              <Stack sx={{ flexGrow: 1, minWidth: 0 }}>
                <Typography sx={{ fontWeight: 600 }}>{p.label}</Typography>
                <Typography variant="body2" color="text.secondary" noWrap>
                  {p.endpoint} · access key {maskKey(p.access_key)}
                </Typography>
              </Stack>
              <Button onClick={() => testSaved(p.id)} aria-label={`Kiểm tra kết nối tới ${p.label}`}>
                Kiểm tra kết nối
              </Button>
              <Button
                color="error"
                onClick={() => invoke("remove_profile", { id: p.id }).then(onChanged).catch(fail)}
                aria-label={`Xoá cluster ${p.label}`}
              >
                Xoá
              </Button>
            </Stack>
            <FormControlLabel
              control={
                <Checkbox
                  size="small"
                  checked={!!p.plain_user}
                  onChange={(e) => invoke("profile_set_plain", { id: p.id, plain: e.target.checked }).then(onChanged).catch(fail)}
                />
              }
              label={<Typography variant="body2">{PLAIN_LABEL}</Typography>}
            />
            <ProfileProxy profile={p} onChanged={onChanged} fail={fail} />
            {rowOutcome[p.id] && outcomeAlert(rowOutcome[p.id], { mt: 1 })}
          </Paper>
        ))}
      </Stack>

      <Paper variant="outlined" sx={{ p: 2, mt: 3 }}>
        <Typography variant="h6" component="h2" gutterBottom>
          Cài đặt chung — Mạng
        </Typography>
        <Stack spacing={2}>
          <Typography variant="body2" color="text.secondary">
            Cách app đi ra mạng khi một cluster không có lựa chọn riêng. "Tự động" dùng HTTP_PROXY / HTTPS_PROXY / NO_PROXY của môi
            trường; "Không dùng proxy" luôn kết nối thẳng dù môi trường có đặt proxy; "Tùy chỉnh" luôn đi qua proxy bạn nhập.
          </Typography>
          <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
            <ProxyPicker value={networkDraft} onChange={(next) => next && setNetworkDraft(next)} name="chung" />
            <Button variant="contained" onClick={saveNetwork} disabled={sameProxy(networkDraft, network) || !proxyReady(networkDraft)}>
              Lưu cài đặt mạng
            </Button>
          </Stack>
          {networkOutcome && outcomeAlert(networkOutcome)}
        </Stack>
      </Paper>
    </>
  );
}
