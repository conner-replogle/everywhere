import { describe, expect, test } from "bun:test";
import { addressToUrl } from "../src/lib/web-tabs";

describe("addressToUrl", () => {
  test("keeps full URLs", () => {
    expect(addressToUrl("https://github.com/a?b=1")).toBe("https://github.com/a?b=1");
    expect(addressToUrl("  http://example.com ")).toBe("http://example.com");
    expect(addressToUrl("about:blank")).toBe("about:blank");
  });

  test("addresses get https, this machine's get http", () => {
    expect(addressToUrl("github.com")).toBe("https://github.com");
    expect(addressToUrl("en.wikipedia.org/wiki/Electron")).toBe("https://en.wikipedia.org/wiki/Electron");
    expect(addressToUrl("localhost:5173")).toBe("http://localhost:5173");
    expect(addressToUrl("127.0.0.1:8787/api")).toBe("http://127.0.0.1:8787/api");
    expect(addressToUrl("app.localhost:3000")).toBe("http://app.localhost:3000");
  });

  test("anything else is a search", () => {
    expect(addressToUrl("electron webview")).toBe("https://www.google.com/search?q=electron%20webview");
    expect(addressToUrl("react")).toBe("https://www.google.com/search?q=react");
  });
});
