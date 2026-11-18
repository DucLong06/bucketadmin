export type PresignUnit = "s" | "m" | "h";
/** SigV4 presigned URLs cannot live longer than a week. */
export const MAX_PRESIGN_SECS = 7 * 24 * 3600;
const FACTOR: Record<PresignUnit, number> = { s: 1, m: 60, h: 3600 };

/** Expiry in seconds for "15" + "m"; null when it is not a whole number between 1 s and 7 days. */
export function presignSeconds(amount: string, unit: PresignUnit): number | null {
  if (!/^\d+$/.test(amount.trim())) return null;
  const seconds = Number(amount) * FACTOR[unit];
  return seconds >= 1 && seconds <= MAX_PRESIGN_SECS ? seconds : null;
}
