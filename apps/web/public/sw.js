// Service worker: makes the app installable and lets it start without a
// round trip. Everything live (API, WebSockets, WebRTC) bypasses it.
//
// - Page loads: network first, falling back to the last cached app shell.
// - /assets/*: content-hashed and immutable, so cache first.
// - Everything else (/api, /mcp, /oauth, /i, /.well-known, …): untouched.

const SHELL = "shell-v1";
const ASSETS = "assets-v1";
const MAX_ASSETS = 150;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key !== SHELL && key !== ASSETS) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

// Worker-served paths that are pages or API, never the SPA.
const WORKER_PATHS = /^\/(api|i|mcp|oauth|\.well-known)(\/|$)/;

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || WORKER_PATHS.test(url.pathname)) return;

  if (req.mode === "navigate") {
    event.respondWith(shell(req));
  } else if (url.pathname.startsWith("/assets/")) {
    event.respondWith(asset(req));
  }
});

async function shell(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(req);
    // Every SPA route serves the same index.html; keep one copy.
    if (res.ok && res.type === "basic") await cache.put("/", res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match("/");
    if (cached) return cached;
    throw err;
  }
}

async function asset(req) {
  const cache = await caches.open(ASSETS);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok && res.type === "basic") {
    await cache.put(req, res.clone());
    // Old builds' chunks pile up; keys() is in insertion order, so drop the oldest.
    const keys = await cache.keys();
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS))) await cache.delete(key);
  }
  return res;
}
