import { describe, expect, test } from "bun:test";
import { dashboardCSP } from "../src/dashboard";

describe("dashboardCSP", () => {
  const csp = dashboardCSP("https://ai.replogle.dev");
  test("names the origin, never 'self' (WebKit matches it against the sandbox's opaque origin)", () => {
    expect(csp).not.toContain("'self'");
    expect(csp).toContain("script-src https://ai.replogle.dev blob:");
    expect(csp).toContain("frame-ancestors https://ai.replogle.dev");
  });
  test("no network", () => {
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("default-src 'none'");
  });
});
