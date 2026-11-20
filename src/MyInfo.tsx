import { type ReactNode, useEffect, useState } from "react";
import { Accordion, AccordionDetails, AccordionSummary, Chip, LinearProgress, Stack, Typography } from "@mui/material";
import { invoke, maskKey, type Quota, type Usage, type UserInfo } from "./api";
import type { Access } from "./caps";
import { formatBytes } from "./format";
import { t } from "./i18n";
import { ErrorAlert, useAction } from "./ui";
import { dayStartUtc, daysAgo, usageRows, usageTotals } from "./usage";

type Quotas = { user: Quota; bucket: Quota };
const USAGE_DAYS = 30;

const quotaText = (q: Quota) =>
  q.enabled
    ? t("myinfo.quota", {
        size: q.max_size < 0 ? t("myinfo.quota.anySize") : formatBytes(q.max_size),
        objects: q.max_objects < 0 ? t("myinfo.quota.anyObjects") : t("myinfo.quota.objects", { n: q.max_objects }),
      })
    : t("myinfo.quota.off");

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
        setUsage(await invoke<Usage>("usage_get", { clusterId, uid, start: dayStartUtc(daysAgo(USAGE_DAYS)), end: dayStartUtc(daysAgo(0), 1) }));
      }
    });
  }, [open, clusterId, access]);

  const totals = usage && usageTotals(usageRows(usage));
  return (
    <Accordion expanded={open} onChange={(_, now) => setOpen(now)} variant="outlined" disableGutters sx={{ mb: 2 }}>
      <AccordionSummary aria-controls="my-info-content" id="my-info-header">
        <Typography component="h2" variant="subtitle1">
          {t("myinfo.title", { uid })}
        </Typography>
      </AccordionSummary>
      <AccordionDetails>
        {busy && <LinearProgress aria-label={t("myinfo.loading")} />}
        <ErrorAlert error={error} sx={{ mb: 1 }} />
        <Stack spacing={0.75}>
          <Typography variant="body2" color="text.secondary">
            {t("myinfo.readOnly")}
          </Typography>
          {!access.users && <Row label={t("myinfo.infoQuota")}>{t("myinfo.needCap", { cap: "users=read" })}</Row>}
          {user && (
            <>
              <Row label={t("myinfo.uid")}>{uid}</Row>
              <Row label={t("myinfo.displayName")}>{user.display_name || "—"}</Row>
              <Row label={t("myinfo.email")}>{user.email || "—"}</Row>
              <Row label={t("myinfo.status")}>{user.suspended ? t("myinfo.suspended") : t("myinfo.active")}</Row>
              <Row label={t("myinfo.maxBuckets")}>{user.max_buckets ?? "—"}</Row>
              <Row label={t("myinfo.accessKey")}>{user.keys.map((k) => maskKey(k.access_key)).join(", ") || "—"}</Row>
              <Row label={t("myinfo.caps")}>
                {user.caps.length === 0
                  ? t("myinfo.none")
                  : user.caps.map((c) => <Chip key={c.type} size="small" variant="outlined" label={`${c.type}=${c.perm}`} sx={{ mr: 0.5 }} />)}
              </Row>
            </>
          )}
          {quotas && (
            <>
              <Row label={t("myinfo.userQuota")}>{quotaText(quotas.user)}</Row>
              <Row label={t("myinfo.bucketQuota")}>{quotaText(quotas.bucket)}</Row>
            </>
          )}
          {!access.usage && <Row label={t("myinfo.usage", { days: USAGE_DAYS })}>{t("myinfo.needCap", { cap: "usage=read" })}</Row>}
          {totals && (
            <Row label={t("myinfo.usage", { days: USAGE_DAYS })}>
              {totals.ops === 0
                ? t("myinfo.usage.none")
                : t("myinfo.usage.totals", { ops: totals.ops, ok: totals.successful_ops, sent: formatBytes(totals.bytes_sent), received: formatBytes(totals.bytes_received) })}
            </Row>
          )}
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}
