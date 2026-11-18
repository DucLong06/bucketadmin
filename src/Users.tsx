import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  LinearProgress,
  Link,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import { invoke, uidOf, type KeyPair, type Profile, type UserInfo } from "./api";
import CreateUserDialog from "./CreateUserDialog";
import { SecretDialog, useAction } from "./ui";

type Props = { profiles: Profile[]; clusterId: string; onClusterChange: (id: string) => void };

const byUid = (a: UserInfo, b: UserInfo) => uidOf(a).localeCompare(uidOf(b));

export default function Users({ profiles, clusterId, onClusterChange }: Props) {
  const [users, setUsers] = useState<UserInfo[] | null>(null);
  const [filter, setFilter] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [newKeys, setNewKeys] = useState<KeyPair[] | null>(null);
  const { busy, error, run } = useAction();
  const request = useRef(0);

  async function load() {
    if (!clusterId) return;
    const mine = ++request.current;
    const loaded = await run(() => invoke<UserInfo[]>("users_list", { clusterId }));
    // A slower answer for a cluster the user already left must not overwrite the table.
    if (mine === request.current) setUsers(loaded ? loaded.sort(byUid) : null);
  }
  useEffect(() => {
    setUsers(null);
    load();
  }, [clusterId]);

  function onCreated(user: UserInfo) {
    setNewKeys(user.keys); // shown once in the dialog, never kept in the table state
    const row = { ...user, keys: user.keys.map((k) => ({ ...k, secret_key: "" })) };
    setUsers((list) => [...(list ?? []), row].sort(byUid));
  }

  const needle = filter.trim().toLowerCase();
  const shown = (users ?? []).filter((u) => uidOf(u).toLowerCase().includes(needle));

  if (profiles.length === 0) {
    return <Alert severity="info">Chưa có cluster nào. Hãy thêm cluster ở tab Clusters trước.</Alert>;
  }
  return (
    <>
      <Typography variant="h5" component="h1" gutterBottom>
        Users
      </Typography>
      <Stack direction="row" spacing={2} sx={{ mb: 2, alignItems: "center" }}>
        <TextField
          select
          label="Cluster"
          value={clusterId}
          onChange={(e) => onClusterChange(e.target.value)}
          size="small"
          sx={{ minWidth: 200 }}
          slotProps={{ select: { native: true } }}
        >
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </TextField>
        <TextField label="Tìm theo uid" value={filter} onChange={(e) => setFilter(e.target.value)} size="small" />
        <Box sx={{ flexGrow: 1 }} />
        <Button onClick={load} disabled={busy}>
          Làm mới
        </Button>
        <Button variant="contained" onClick={() => setCreateOpen(true)}>
          Tạo user
        </Button>
      </Stack>
      {busy && <LinearProgress aria-label="Đang tải danh sách user" />}
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      <TableContainer component={Paper} variant="outlined">
        <Table size="small" aria-label="Danh sách user">
          <TableHead>
            <TableRow>
              <TableCell>uid</TableCell>
              <TableCell>Display name</TableCell>
              <TableCell>Trạng thái</TableCell>
              <TableCell>Caps</TableCell>
              <TableCell align="right">Số keys</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {shown.map((u) => (
              <TableRow key={uidOf(u)} hover>
                <TableCell sx={{ fontFamily: "monospace" }}>{uidOf(u)}</TableCell>
                <TableCell>{u.display_name}</TableCell>
                <TableCell>
                  {u.suspended ? (
                    <Chip size="small" color="warning" label="Suspended" />
                  ) : (
                    <Chip size="small" color="success" variant="outlined" label="Hoạt động" />
                  )}
                </TableCell>
                <TableCell>
                  <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: "wrap" }}>
                    {u.caps.map((c) => (
                      <Chip key={c.type} size="small" variant="outlined" label={`${c.type}=${c.perm}`} />
                    ))}
                  </Stack>
                </TableCell>
                <TableCell align="right">{u.keys.length}</TableCell>
              </TableRow>
            ))}
            {users !== null && shown.length === 0 && (
              <TableRow>
                <TableCell colSpan={5}>
                  <Typography color="text.secondary">Không có user nào khớp.</Typography>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>
      {users !== null && (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          Hiển thị {shown.length}/{users.length} user
        </Typography>
      )}
      <CreateUserDialog
        clusterId={clusterId}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={onCreated}
      />
      <SecretDialog keys={newKeys} onClose={() => setNewKeys(null)} />
    </>
  );
}
