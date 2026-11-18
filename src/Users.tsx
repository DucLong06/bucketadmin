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
import { ClusterSelect, ErrorAlert, SecretDialog, useAction } from "./ui";
import UserDrawer from "./UserDrawer";

type Props = { profiles: Profile[]; clusterId: string; onClusterChange: (id: string) => void };
type UsersPage = { users: UserInfo[]; next_marker: string | null };

const PAGE_SIZE = 25;

const byUid = (a: UserInfo, b: UserInfo) => uidOf(a).localeCompare(uidOf(b));

export default function Users({ profiles, clusterId, onClusterChange }: Props) {
  const [users, setUsers] = useState<UserInfo[] | null>(null);
  const [filter, setFilter] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [nextMarker, setNextMarker] = useState<string | null>(null);
  const [newKeys, setNewKeys] = useState<KeyPair[] | null>(null);
  const { busy, error, run } = useAction();
  const request = useRef(0);

  // RGW lists users by an opaque marker, not by offset: pages can only be appended in order.
  async function load(marker: string | null) {
    if (!clusterId) return;
    const mine = ++request.current;
    const page = await run(() => invoke<UsersPage>("users_list", { clusterId, marker, limit: PAGE_SIZE }));
    // A slower answer for a cluster the user already left must not overwrite the table.
    if (mine !== request.current) return;
    if (!page) {
      if (marker === null) setUsers(null);
      return;
    }
    setUsers((list) => [...(marker === null ? [] : (list ?? [])), ...page.users].sort(byUid));
    setNextMarker(page.next_marker);
  }
  useEffect(() => {
    setUsers(null);
    setNextMarker(null);
    setSelected(null);
    load(null);
  }, [clusterId]);

  function onCreated(user: UserInfo) {
    setNewKeys(user.keys); // shown once in the dialog, never kept in the table state
    const row = { ...user, keys: user.keys.map((k) => ({ ...k, secret_key: "" })) };
    setUsers((list) => [...(list ?? []), row].sort(byUid));
  }

  const replaceUser = (user: UserInfo) =>
    setUsers((list) => (list ?? []).map((u) => (uidOf(u) === uidOf(user) ? user : u)));
  function onDeleted(uid: string) {
    setSelected(null);
    setUsers((list) => (list ?? []).filter((u) => uidOf(u) !== uid));
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
        <ClusterSelect profiles={profiles} value={clusterId} onChange={onClusterChange} />
        <TextField label="Tìm theo uid" value={filter} onChange={(e) => setFilter(e.target.value)} size="small" />
        <Box sx={{ flexGrow: 1 }} />
        <Button onClick={() => load(null)} disabled={busy}>
          Làm mới
        </Button>
        <Button variant="contained" onClick={() => setCreateOpen(true)}>
          Tạo user
        </Button>
      </Stack>
      {busy && <LinearProgress aria-label="Đang tải danh sách user" />}
      <ErrorAlert error={error} sx={{ mb: 2 }} />
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
                <TableCell>
                  <Link
                    component="button"
                    sx={{ fontFamily: "monospace" }}
                    onClick={() => setSelected(uidOf(u))}
                    aria-label={`Mở chi tiết user ${uidOf(u)}`}
                  >
                    {uidOf(u)}
                  </Link>
                </TableCell>
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
        <Stack direction="row" spacing={2} sx={{ mt: 1, alignItems: "center" }}>
          <Typography variant="body2" color="text.secondary">
            Hiển thị {shown.length}/{users.length} user đã tải
            {nextMarker ? " — cluster còn user chưa tải; ô tìm kiếm chỉ lọc trong phần đã tải." : " — đã tải hết."}
          </Typography>
          {nextMarker && (
            <Button size="small" variant="outlined" onClick={() => load(nextMarker)} disabled={busy}>
              Tải thêm {PAGE_SIZE} user
            </Button>
          )}
        </Stack>
      )}
      <CreateUserDialog
        clusterId={clusterId}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={onCreated}
      />
      <SecretDialog keys={newKeys} onClose={() => setNewKeys(null)} />
      <UserDrawer
        clusterId={clusterId}
        user={(users ?? []).find((u) => uidOf(u) === selected) ?? null}
        onUser={replaceUser}
        onDeleted={onDeleted}
        onClose={() => setSelected(null)}
      />
    </>
  );
}
