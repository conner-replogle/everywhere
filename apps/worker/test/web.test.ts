import { describe, expect, test } from "bun:test";
import { frameable } from "../src/routes/web";

const APP = "https://ai.replogle.dev";
const check = (h: Record<string, string>) => frameable(new Headers(h), APP);

describe("frameable", () => {
  test("no headers: allowed", () => expect(check({})).toBe(true));
  test("X-Frame-Options refuses another origin", () => {
    expect(check({ "x-frame-options": "deny" })).toBe(false);
    expect(check({ "x-frame-options": "SAMEORIGIN" })).toBe(false);
  });
  test("frame-ancestors 'none' or 'self' refuses (GitHub)", () => {
    expect(check({ "content-security-policy": "default-src 'none'; frame-ancestors 'none'", "x-frame-options": "deny" })).toBe(false);
    expect(check({ "content-security-policy": "frame-ancestors 'self'" })).toBe(false);
  });
  test("frame-ancestors that names the app allows it, over X-Frame-Options", () => {
    expect(check({ "content-security-policy": "frame-ancestors 'self' https://ai.replogle.dev", "x-frame-options": "deny" })).toBe(true);
    expect(check({ "content-security-policy": "frame-ancestors *.replogle.dev" })).toBe(true);
    expect(check({ "content-security-policy": "frame-ancestors *" })).toBe(true);
    expect(check({ "content-security-policy": "frame-ancestors https:" })).toBe(true);
  });
  test("frame-ancestors for other sites refuses", () => {
    expect(check({ "content-security-policy": "frame-ancestors https://example.com http://ai.replogle.dev" })).toBe(false);
  });
  test("a CSP without frame-ancestors leaves X-Frame-Options to decide", () => {
    expect(check({ "content-security-policy": "default-src 'self'" })).toBe(true);
    expect(check({ "content-security-policy": "default-src 'self'", "x-frame-options": "DENY" })).toBe(false);
  });
  test("every policy has to allow it", () => {
    expect(check({ "content-security-policy": "frame-ancestors *, frame-ancestors 'none'" })).toBe(false);
  });
});
