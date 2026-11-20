import { t } from "./i18n";

/** Error message for an RGW endpoint, or null when it is usable. The Rust side validates again. */
export function endpointError(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return t("endpoint.url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return t("endpoint.scheme");
  }
  return null;
}
