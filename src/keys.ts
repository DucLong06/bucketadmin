// Format rules for an S3 key pair typed in by hand. src-tauri/src/ops.rs (`validate_key_pair`)
// enforces the same rules; this copy only gives feedback while typing.

export function accessKeyError(value: string): string | null {
  if (!/^[A-Za-z0-9]{16,128}$/.test(value)) return "Access key gồm 16–128 ký tự chữ và số, không có dấu cách.";
  return null;
}

export function secretKeyError(value: string): string | null {
  if (!/^[A-Za-z0-9/+=]{32,128}$/.test(value)) return "Secret key gồm 32–128 ký tự: chữ, số và / + =.";
  return null;
}
