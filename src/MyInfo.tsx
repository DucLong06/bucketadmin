import { type ReactNode, useEffect, useState } from "react";
import { Accordion, AccordionDetails, AccordionSummary, Chip, LinearProgress, Stack, Typography } from "@mui/material";
import { invoke, maskKey, type Quota, type Usage, type UserInfo } from "./api";
import type { Access } from "./caps";
import { formatBytes } from "./format";
import { ErrorAlert, useAction } from "./ui";
import { daysAgo, nextDay, usageRows, usageTotals } from "./usage";

type Quotas = { user: Quota; bucket: Quota };
const USAGE_DAYS = 30;

const quotaText = (q: Quota) =>
  q.enabled
    ? `tối đa ${q.max_size < 0 ? "không giới hạn dung lượng" : formatBytes(q.max_size)}, ${q.max_objects < 0 ? "không giới hạn số object" : `${q.max_objects} object`}`
    : "không bật";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Stack direction="row" spacing={2}>
      <Typography variant="body2" color="text.secondary" sx={{ width: 170, flexShrink: 0 }}>
        {label}
      </Typography>
      <Typography variant="body2" component="div" sx={{ minWidth: 0, wordBreak: "break-word" }}>
        {children}
      </Typography>
    </Stack>
  );
}

/** Read-only view of the caller's own user record, quota and usage. It asks only about
 *  `access.uid`: no other user is listed or looked up. Loaded when first opened. */
export default function MyInfo({ clusterId, access, defaultOpen }: { clusterId: string; access: Access; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [user, setUser] = useState<UserInfo | null>(null);
  const [quotas, setQuotas] = useState<Quotas | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const { busy, error, run } = useAction();
  const { uid } = access;

  useEffect(() => {
    if (!open) return;
    setUser(null);
    setQuotas(null);
    setUsage(null);
    run(async () => {
      if (access.users) {
        setUser(await invoke<UserInfo>("user_get", { clusterId, uid }));
        setQuotas(await invoke<Quotas>("quota_get", { clusterId, uid }));
      }
      if (access.usage) {
        // RGW's end date is exclusive: the day after today covers today.
        setUsage(await invoke<Usage>("usage_get", { clusterId, uid, start: daysAgo(USAGE_DAYS), end: nextDay(daysAgo(0)) }));
      }
    });
  }, [open, clusterId, access]);

  const totals = usage && usageTotals(usageRows(usage));
  return (
    <Accordion expanded={open} onChange={(_, now) => setOpen(now)} variant="outlined" disableGutters sx={{ mb: 2 }}>
      <AccordionSummary aria-controls="my-info-content" id="my-info-header">
        <Typography component="h2" variant="subtitle1">
          Thông tin của tôi · {uid}
        </Typography>
      </AccordionSummary>
      <AccordionDetails>
        {busy && <LinearProgress aria-label="Đang tải thông tin của tôi" />}
        <ErrorAlert error={error} sx={{ mb: 1 }} />
        <Stack spacing={0.75}>
          <Typography variant="body2" color="text.secondary">
            Chỉ xem. Đây là thông tin của chính user đang kết nối; app không liệt kê user khác ở đây.
          </Typography>
          {!access.users && <Row label="Thông tin, quota">Cần cap users=read để xem.</Row>}
          {user && (
            <>
              <Row label="uid">{uid}</Row>
              <Row label="Tên hiển thị">{user.display_name || "—"}</Row>
              <Row label="Email">{user.email || "—"}</Row>
              <Row label="Trạng thái">{user.suspended ? "Bị khoá (suspended)" : "Đang hoạt động"}</Row>
              <Row label="Số bucket tối đa">{user.max_buckets ?? "—"}</Row>
              <Row label="Access key">{user.keys.map((k) => maskKey(k.access_key)).join(", ") || "—"}</Row>
              <Row label="Caps">
                {user.caps.length === 0
                  ? "không có"
                  : user.caps.map((c) => <Chip key={c.type} size="small" variant="outlined" label={`${c.type}=${c.perm}`} sx={{ mr: 0.5 }} />)}
              </Row>
            </>
          )}
          {quotas && (
            <>
              <Row label="Quota của user">{quotaText(quotas.user)}</Row>
              <Row label="Quota mỗi bucket">{quotaText(quotas.bucket)}</Row>
            </>
          )}
          {!access.usage && <Row label={`Usage ${USAGE_DAYS} ngày`}>Cần cap usage=read để xem.</Row>}
          {totals && (
            <Row label={`Usage ${USAGE_DAYS} ngày`}>
              {totals.ops === 0
                ? "Chưa có dữ liệu (không có request nào, hoặc usage log của cluster đang tắt)."
                : `${totals.ops} request (${totals.successful_ops} thành công) · gửi đi ${formatBytes(totals.bytes_sent)} · nhận về ${formatBytes(totals.bytes_received)}`}
            </Row>
          )}
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}
