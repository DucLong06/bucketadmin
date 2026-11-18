import { expect, test } from "vitest";
import { endpointError } from "./endpoint";

test("accepts http and https endpoints", () => {
  expect(endpointError("http://127.0.0.1:7480")).toBeNull();
  expect(endpointError(" https://rgw.corp.example/ ")).toBeNull();
});

test("rejects missing scheme and non-http schemes", () => {
  expect(endpointError("127.0.0.1:7480")).toMatch(/http/);
  expect(endpointError("rgw.corp.example")).toMatch(/URL/);
  expect(endpointError("ftp://rgw.corp.example")).toMatch(/http/);
});
