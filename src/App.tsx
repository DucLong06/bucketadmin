import { type FormEvent, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Alert, Button, Container, Paper, Stack, TextField, Typography } from "@mui/material";
import { endpointError } from "./endpoint";

type Profile = { id: string; label: string; endpoint: string; access_key: string };
type ClusterInfo = { cluster_id: string; version: string | null };
type Outcome = { severity: "success" | "error"; text: string };

const emptyForm = { label: "", endpoint: "", accessKey: "", secretKey: "" };

async function testOutcome(call: Promise<ClusterInfo>): Promise<Outcome> {
  try {
    const info = await call;
    return {
      severity: "success",
      text: `Connected. cluster_id: ${info.cluster_id} · version: ${info.version ?? "not reported"}`,
    };
  } catch (e) {
    return { severity: "error", text: String(e) };
  }
}

export default function App() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [formOutcome, setFormOutcome] = useState<Outcome | null>(null);
  const [rowOutcome, setRowOutcome] = useState<Record<string, Outcome>>({});
  const [busy, setBusy] = useState(false);

  const fail = (e: unknown) => setFormOutcome({ severity: "error", text: String(e) });
  const reload = () => invoke<Profile[]>("list_profiles").then(setProfiles).catch(fail);
  useEffect(() => {
    reload();
  }, []);

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
      setFormOutcome({
        severity: "success",
        text: `Saved "${saved.label}". The secret key is stored in the system keychain.`,
      });
      await reload();
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
    <Container maxWidth="md" sx={{ py: 3 }}>
      <Typography variant="h4" component="h1" gutterBottom>
        Clusters
      </Typography>

      <Paper component="form" onSubmit={save} variant="outlined" sx={{ p: 2, mb: 3 }}>
        <Typography variant="h6" component="h2" gutterBottom>
          Add cluster
        </Typography>
        <Stack spacing={2}>
          {field("label", "Label")}
          {field("endpoint", "Endpoint", {
            placeholder: "http://host:7480",
            error: !!urlError,
            helperText: urlError ?? "RGW address, e.g. http://host:7480",
          })}
          {field("accessKey", "Access key", { autoComplete: "off" })}
          {field("secretKey", "Secret key", { type: "password", autoComplete: "off" })}
          <Stack direction="row" spacing={1}>
            <Button variant="outlined" onClick={testForm} disabled={!canTest}>
              Test connection
            </Button>
            <Button type="submit" variant="contained" disabled={!canTest || !form.label.trim()}>
              Save
            </Button>
          </Stack>
          {formOutcome && <Alert severity={formOutcome.severity}>{formOutcome.text}</Alert>}
        </Stack>
      </Paper>

      <Typography variant="h6" component="h2" gutterBottom>
        Saved clusters
      </Typography>
      {profiles.length === 0 && <Typography color="text.secondary">No clusters saved yet.</Typography>}
      <Stack spacing={1} component="ul" sx={{ listStyle: "none", p: 0, m: 0 }}>
        {profiles.map((p) => (
          <Paper key={p.id} component="li" variant="outlined" sx={{ p: 2 }}>
            <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
              <Stack sx={{ flexGrow: 1, minWidth: 0 }}>
                <Typography sx={{ fontWeight: 600 }}>{p.label}</Typography>
                <Typography variant="body2" color="text.secondary" noWrap>
                  {p.endpoint} · {p.access_key}
                </Typography>
              </Stack>
              <Button onClick={() => testSaved(p.id)} aria-label={`Test connection to ${p.label}`}>
                Test connection
              </Button>
              <Button
                color="error"
                onClick={() => invoke("remove_profile", { id: p.id }).then(reload).catch(fail)}
                aria-label={`Remove ${p.label}`}
              >
                Remove
              </Button>
            </Stack>
            {rowOutcome[p.id] && (
              <Alert severity={rowOutcome[p.id].severity} sx={{ mt: 1 }}>
                {rowOutcome[p.id].text}
              </Alert>
            )}
          </Paper>
        ))}
      </Stack>
    </Container>
  );
}
