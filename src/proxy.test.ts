import { expect, test } from "vitest";
import { proxyMode, proxyOf, proxyReady, sameProxy } from "./ProxyPicker";

test("proxy picker: null is 'follow the app-wide setting', a custom proxy needs a usable URL", () => {
  expect(proxyMode(null)).toBe("inherit");
  expect(proxyOf("inherit")).toBeNull();
  expect(proxyOf("auto")).toEqual({ mode: "auto" });
  expect(proxyOf("none")).toEqual({ mode: "none" });
  expect(proxyOf("custom")).toEqual({ mode: "custom", url: "" });
  expect(proxyMode(proxyOf("custom", "http://p:1"))).toBe("custom");

  expect(proxyReady(null)).toBe(true);
  expect(proxyReady({ mode: "none" })).toBe(true);
  expect(proxyReady({ mode: "custom", url: "" })).toBe(false);
  expect(proxyReady({ mode: "custom", url: "proxy:3128" })).toBe(false);
  expect(proxyReady({ mode: "custom", url: "socks5://proxy:1080" })).toBe(false);
  expect(proxyReady({ mode: "custom", url: " http://proxy:3128 " })).toBe(true);

  expect(sameProxy(null, null)).toBe(true);
  expect(sameProxy({ mode: "none" }, { mode: "none" })).toBe(true);
  expect(sameProxy(null, { mode: "auto" })).toBe(false);
  expect(sameProxy({ mode: "custom", url: "http://a:1" }, { mode: "custom", url: "http://b:1" })).toBe(false);
});
