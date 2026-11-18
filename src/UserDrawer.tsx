import { type ComponentType, useEffect, useState } from "react";
import { Alert, Box, Button, Chip, Drawer, Stack, Tab, Tabs, Typography } from "@mui/material";
import { invoke, uidOf, type UserInfo } from "./api";
import InfoTab from "./InfoTab";
import { explain } from "./errors";
import { ErrorAlert } from "./ui";
import UsageTab from "./UsageTab";
import QuotaTab from "./QuotaTab";
import CapsTab from "./CapsTab";
import KeysTab from "./KeysTab";
import UserBucketsTab from "./UserBucketsTab";
import SubusersTab from "./SubusersTab";

export type UserTabProps = {
  clusterId: string;
  uid: string;
  user: UserInfo;
  /** Re-reads the user from RGW after a change made by the tab. */
  refresh: () => Promise<void>;
  onUser: (user: UserInfo) => void;
  onDeleted: () => void;
};

const allTabs: { label: string; Panel: ComponentType<UserTabProps> }[] = [
  { label: "Thông tin", Panel: InfoTab },
  { label: "Keys", Panel: KeysTab },
  { label: "Subusers", Panel: SubusersTab },
  { label: "Caps", Panel: CapsTab },
  { label: "Quota", Panel: QuotaTab },
  { label: "Buckets", Panel: UserBucketsTab },
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
  // Why the Usage tab is hidden, when the cluster refuses usage queries.
  const [usageOff, setUsageOff] = useState<string | null>(null);
  const uid = user ? uidOf(user) : "";
  useEffect(() => {
    setTab(0);
    setError(null);
  }, [uid]);

  useEffect(() => {
    setUsageOff(null);
    if (!clusterId) return;
    invoke<{ supported: boolean; reason: string | null }>("usage_support", { clusterId })
      .then((s) => setUsageOff(s.supported ? null : (s.reason ?? "")))
      .catch(() => {}); // unreachable cluster: keep the tab, it reports the error itself
  }, [clusterId]);
  const tabs = usageOff === null ? allTabs : allTabs.filter((t) => t.Panel !== UsageTab);

  const refresh = () =>
    invoke<UserInfo>("user_get", { clusterId, uid })
      .then(onUser)
      .catch((e) => setError(String(e)));
  const Panel = (tabs[tab] ?? tabs[0]).Panel;

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
          <Tabs
            value={tab}
            onChange={(_, value) => setTab(value)}
            aria-label="Chi tiết user"
            // Seven tabs: narrower than the default so they fit the drawer, scrollable if they still do not.
            variant="scrollable"
            scrollButtons="auto"
            sx={{ "& .MuiTab-root": { minWidth: 0, px: 1.75 } }}
          >
            {tabs.map((t, i) => (
              <Tab key={t.label} value={i} label={t.label} />
            ))}
          </Tabs>
          {usageOff !== null && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }} title={usageOff}>
              Tab Usage bị ẩn: cluster này không cho truy vấn usage ({explain(usageOff).message})
            </Typography>
          )}
          <ErrorAlert error={error} sx={{ mt: 1 }} />
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
