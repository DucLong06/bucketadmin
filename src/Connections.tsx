import { type FormEvent, useEffect, useState } from "react";
import { Alert, Box, Button, Paper, Stack, TextField, Typography } from "@mui/material";
import { invoke, isInternal, maskKey, type EndpointKind, type Profile, type Proxy } from "./api";
import { endpointError } from "./endpoint";
import { ProxyPicker, proxyReady, sameProxy } from "./ProxyPicker";
import { ErrorAlert } from "./ui";

type Outcome = { severity: "success" | "warning" | "error"; text: string };

const outcomeAlert = (o: Outcome, sx?: object) =>
  o.severity === "error" ? <ErrorAlert error={o.text} sx={sx} /> : <Alert severity={o.severity} sx={sx}>{o.text}</Alert>;

const emptyForm = { label: "", endpoint: "", accessKey: "", secretKey: "", adminAccessKey: "", adminSecretKey: "" };
/** Keys and paths are the one place the UI uses a monospace face. */
const Mono = ({ children }: { children: string }) => (
  <Box component="span" sx={{ fontFamily: "monospace" }}>
    {children}
  </Box>
);
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
type Opened = { access_key: string; buckets: unknown[] };
const connected = (buckets: number): Outcome => ({
  severity: "success",
  text: `Kết nối thành công: key hợp lệ, user của key sở hữu ${buckets} bucket.`,
});

/** The connections screen: the S3 endpoints the app browses, each with the user's own key
 *  (secret in the OS keychain), an optional admin key, and its proxy choice. */
export default function Connections({ profiles, onChanged }: { profiles: Profile[]; onChanged: () => void }) {
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
      setNetworkOutcome({ severity: "success", text: "Đã lưu. Áp dụng cho mọi kết nối không có lựa chọn proxy riêng, và cho việc kiểm tra bản mới." });
    } catch (e) {
      setNetworkOutcome({ severity: "error", text: String(e) });
    }
  }
  const [formOutcome, setFormOutcome] = useState<Outcome | null>(null);
  const [rowOutcome, setRowOutcome] = useState<Record<string, Outcome>>({});
  const [busy, setBusy] = useState(false);

  const fail = (e: unknown) => setFormOutcome({ severity: "error", text: String(e) });
  const urlError = form.endpoint ? endpointError(form.endpoint) : null;
  // The admin key is optional, but half of one is a mistake.
  const adminGiven = !!form.adminAccessKey.trim() || !!form.adminSecretKey;
  const adminReady = !adminGiven || (!!form.adminAccessKey.trim() && !!form.adminSecretKey);
  const canTest = !busy && !!form.endpoint && !urlError && !!form.accessKey && !!form.secretKey && proxyReady(formProxy);
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
    const { endpoint, accessKey, secretKey } = form;
    try {
      setFormOutcome(connected(await invoke<number>("test_s3", { endpoint, accessKey, secretKey, proxy: formProxy })));
    } catch (e) {
      fail(e);
    }
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
      const saved = await invoke<Profile>("add_profile", { label, endpoint, ...first });
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
    let outcome: Outcome;
    try {
      outcome = connected((await invoke<Opened>("browse_open", { clusterId: id, uid: "" })).buckets.length);
    } catch (e) {
      outcome = { severity: "error", text: String(e) };
    }
    setRowOutcome((prev) => ({ ...prev, [id]: outcome }));
  }

  const keySx = { htmlInput: { style: { fontFamily: "monospace" } } };
  return (
    <>
      <Typography variant="overline" color="primary" component="p">
        Kết nối
      </Typography>
      <Typography variant="h4" component="h1" gutterBottom>
        Kết nối
      </Typography>
      <Typography color="text.secondary" sx={{ mb: 3, maxWidth: 720 }}>
        Mỗi kết nối là một endpoint S3 (Ceph RGW) cùng key của bạn. App duyệt bucket bằng đúng key đó: bạn thấy và làm được
        những gì key được phép.
      </Typography>

      <Paper component="form" onSubmit={save} variant="outlined" sx={{ p: 3, mb: 4 }}>
        <Typography variant="h6" component="h2" gutterBottom>
          Thêm kết nối
        </Typography>
        <Stack spacing={2}>
          {field("label", "Tên hiển thị", { required: true })}
          {field("endpoint", "Endpoint", {
            required: true,
            placeholder: "http://host:7480",
            error: !!urlError,
            helperText: urlError ?? "Địa chỉ S3 của RGW, ví dụ http://host:7480",
          })}
          {field("accessKey", "Access key của tôi", { required: true, autoComplete: "off", slotProps: keySx })}
          {field("secretKey", "Secret key của tôi", {
            required: true,
            type: "password",
            autoComplete: "off",
            helperText: "Giống key bạn dùng với rclone, s3cmd… Secret nằm trong keychain của hệ thống, không ghi ra file.",
          })}
          <details>
            <summary>Key admin (không bắt buộc)</summary>
            <Stack spacing={2} sx={{ mt: 2 }}>
              <Typography variant="body2" color="text.secondary">
                Chỉ cần khi key của bạn không có caps mà bạn muốn xem "Thông tin của tôi" (quota, usage), hoặc duyệt thay một
                user khác. Key admin không bao giờ được dùng để ký request S3.
              </Typography>
              {field("adminAccessKey", "Access key admin", { autoComplete: "off", slotProps: keySx })}
              {field("adminSecretKey", "Secret key admin", {
                type: "password",
                autoComplete: "off",
                error: !adminReady,
                helperText: adminReady ? undefined : "Nhập đủ cả access key và secret key admin, hoặc để trống cả hai.",
              })}
            </Stack>
          </details>
          <ProxyPicker value={formProxy} onChange={setFormProxy} inherit name="của kết nối mới" />
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
            <Button type="submit" variant="contained" disabled={!canTest || !adminReady || !form.label.trim()}>
              Lưu
            </Button>
          </Stack>
          {formOutcome && outcomeAlert(formOutcome)}
        </Stack>
      </Paper>

      <Typography variant="h6" component="h2" gutterBottom>
        Kết nối đã lưu
      </Typography>
      {profiles.length === 0 && <Typography color="text.secondary">Chưa có kết nối nào.</Typography>}
      <Stack spacing={1.5} component="ul" sx={{ listStyle: "none", p: 0, m: 0 }}>
        {profiles.map((p) => (
          <Paper key={p.id} component="li" variant="outlined" sx={{ p: 2.5 }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
              <Stack sx={{ flexGrow: 1, minWidth: 0 }}>
                <Typography sx={{ fontWeight: 600 }}>{p.label}</Typography>
                <Typography variant="body2" color="text.secondary" noWrap>
                  <Mono>{p.endpoint}</Mono> · key của tôi <Mono>{maskKey(p.browse_access_key ?? p.access_key)}</Mono>
                  {p.browse_access_key && p.browse_access_key !== p.access_key && (
                    <>
                      {" "}
                      · key admin <Mono>{maskKey(p.access_key)}</Mono>
                    </>
                  )}
                </Typography>
              </Stack>
              <Button onClick={() => testSaved(p.id)} aria-label={`Kiểm tra kết nối tới ${p.label}`}>
                Kiểm tra kết nối
              </Button>
              <Button
                color="error"
                onClick={() => invoke("remove_profile", { id: p.id }).then(onChanged).catch(fail)}
                aria-label={`Xoá kết nối ${p.label}`}
              >
                Xoá
              </Button>
            </Stack>
            <ProfileProxy profile={p} onChanged={onChanged} fail={fail} />
            {rowOutcome[p.id] && outcomeAlert(rowOutcome[p.id], { mt: 1 })}
          </Paper>
        ))}
      </Stack>

      <Paper variant="outlined" sx={{ p: 3, mt: 4 }}>
        <Typography variant="h6" component="h2" gutterBottom>
          Cài đặt chung — Mạng
        </Typography>
        <Stack spacing={2}>
          <Typography variant="body2" color="text.secondary">
            Cách app đi ra mạng khi một kết nối không có lựa chọn riêng. "Tự động" dùng HTTP_PROXY / HTTPS_PROXY / NO_PROXY của
            môi trường; "Không dùng proxy" luôn kết nối thẳng dù môi trường có đặt proxy; "Tùy chỉnh" luôn đi qua proxy bạn nhập.
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
