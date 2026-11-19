import { type FormEvent, useState } from "react";
import { Alert, Button, Checkbox, FormControlLabel, Paper, Stack, TextField, Typography } from "@mui/material";
import { invoke, maskKey, type ClusterInfo, type Profile } from "./api";
import { endpointError } from "./endpoint";
import { ErrorAlert } from "./ui";

type Outcome = { severity: "success" | "warning" | "error"; text: string };

const outcomeAlert = (o: Outcome, sx?: object) =>
  o.severity === "error" ? <ErrorAlert error={o.text} sx={sx} /> : <Alert severity={o.severity} sx={sx}>{o.text}</Alert>;

const emptyForm = { label: "", endpoint: "", accessKey: "", secretKey: "" };
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
  const [formOutcome, setFormOutcome] = useState<Outcome | null>(null);
  const [rowOutcome, setRowOutcome] = useState<Record<string, Outcome>>({});
  const [busy, setBusy] = useState(false);

  const fail = (e: unknown) => setFormOutcome({ severity: "error", text: String(e) });
  const urlError = form.endpoint ? endpointError(form.endpoint) : null;
  const canTest = !busy && !!form.endpoint && !urlError && !!form.accessKey && !!form.secretKey;

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
    setFormOutcome(await testOutcome(invoke("test_connection", { endpoint, accessKey, secretKey })));
    setBusy(false);
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const saved = await invoke<Profile>("add_profile", form);
      setForm(emptyForm);
      setPlain(false);
      // The profile exists from here on. If ticking it fails, it is still listed (unticked)
      // and the error says why; the box in its row can be ticked again.
      try {
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
            {rowOutcome[p.id] && outcomeAlert(rowOutcome[p.id], { mt: 1 })}
          </Paper>
        ))}
      </Stack>
    </>
  );
}
