import { expect, test } from "vitest";
import { endpointError } from "./endpoint";
import { applyLang } from "./i18n";

test("accepts http and https endpoints", () => {
  expect(endpointError("http://127.0.0.1:7480")).toBeNull();
  expect(endpointError(" https://rgw.corp.example/ ")).toBeNull();
});

test("rejects missing scheme and non-http schemes", () => {
  expect(endpointError("127.0.0.1:7480")).toMatch(/http/);
  expect(endpointError("rgw.corp.example")).toMatch(/URL/);
  expect(endpointError("ftp://rgw.corp.example")).toMatch(/http/);
  applyLang("vi");
  expect(endpointError("rgw.corp.example")).toBe("Nhập URL dạng http://host:7480");
  expect(endpointError("ftp://rgw.corp.example")).toBe("Endpoint phải bắt đầu bằng http:// hoặc https://");
  applyLang("en");
  expect(endpointError("rgw.corp.example")).toBe("Enter a URL like http://host:7480");
  expect(endpointError("ftp://rgw.corp.example")).toBe("The endpoint must start with http:// or https://");
});
