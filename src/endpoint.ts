/** Error message for an RGW endpoint, or null when it is usable. The Rust side validates again. */
export function endpointError(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return "Enter a URL like http://host:7480";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "Endpoint must start with http:// or https://";
  }
  return null;
}
