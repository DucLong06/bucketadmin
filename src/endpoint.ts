/** Error message for an RGW endpoint, or null when it is usable. The Rust side validates again. */
export function endpointError(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return "Nhập URL dạng http://host:7480";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "Endpoint phải bắt đầu bằng http:// hoặc https://";
  }
  return null;
}
