import { type ComponentType, useEffect, useState } from "react";
import { Alert, Box, Button, Chip, Drawer, Stack, Tab, Tabs, Typography } from "@mui/material";
import { invoke, uidOf, type UserInfo } from "./api";
import InfoTab from "./InfoTab";
import UsageTab from "./UsageTab";
import QuotaTab from "./QuotaTab";
import CapsTab from "./CapsTab";
import KeysTab from "./KeysTab";

export type UserTabProps = {
  clusterId: string;
  uid: string;
  user: UserInfo;
  /** Re-reads the user from RGW after a change made by the tab. */
  refresh: () => Promise<void>;
  onUser: (user: UserInfo) => void;
  onDeleted: () => void;
};

const tabs: { label: string; Panel: ComponentType<UserTabProps> }[] = [
  { label: "Thông tin", Panel: InfoTab },
  { label: "Keys", Panel: KeysTab },
  { label: "Caps", Panel: CapsTab },
  { label: "Quota", Panel: QuotaTab },
  { label: "Usage", Panel: UsageTab },
];

type Props = {
  clusterId: string;
  user: UserInfo | null;
  onUser: (user: UserInfo) => void;
  onDeleted: (uid: string) => void;
  onClose: () => void;
};

export default function UserDrawer({ clusterId, user, onUser, onDeleted, onClose }: Props) {
  const [tab, setTab] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const uid = user ? uidOf(user) : "";
  useEffect(() => {
    setTab(0);
    setError(null);
  }, [uid]);

  const refresh = () =>
    invoke<UserInfo>("user_get", { clusterId, uid })
      .then(onUser)
      .catch((e) => setError(String(e)));
  const Panel = tabs[tab].Panel;

  return (
    <Drawer anchor="right" open={user !== null} onClose={onClose}>
      {user && (
        <Box sx={{ width: 700, maxWidth: "100vw", p: 3 }}>
          <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 1 }}>
            <Typography variant="h6" component="h2" sx={{ flexGrow: 1, fontFamily: "monospace" }}>
              {uid}
            </Typography>
            {!!user.suspended && <Chip size="small" color="warning" label="Suspended" />}
            <Button onClick={onClose}>Đóng</Button>
          </Stack>
          <Tabs value={tab} onChange={(_, value) => setTab(value)} aria-label="Chi tiết user">
            {tabs.map((t, i) => (
              <Tab key={t.label} value={i} label={t.label} />
            ))}
          </Tabs>
          {error && (
            <Alert severity="error" sx={{ mt: 1 }}>
              {error}
            </Alert>
          )}
          <Box sx={{ pt: 2 }}>
            <Panel
              key={uid}
              clusterId={clusterId}
              uid={uid}
              user={user}
              refresh={refresh}
              onUser={onUser}
              onDeleted={() => onDeleted(uid)}
            />
          </Box>
        </Box>
      )}
    </Drawer>
  );
}
