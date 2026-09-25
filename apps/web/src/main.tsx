import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerServiceWorker } from "@/lib/pwa";
import { routeTree } from "./routeTree.gen";
import "./styles.css";

registerServiceWorker();

const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

// A clicked notification opens its thread in this window (sw.js).
navigator.serviceWorker?.addEventListener("message", (e: MessageEvent<{ t?: string; url?: string }>) => {
  if (e.data?.t === "navigate" && typeof e.data.url === "string" && e.data.url.startsWith("/") && !e.data.url.startsWith("//")) {
    void router.navigate({ href: e.data.url });
  }
});

// iOS Safari overlays the soft keyboard instead of resizing the page (Android honors
// interactive-widget in index.html). Size the app to what's visible so the composer
// and the terminal's cursor line stay above the keyboard.
const vv = window.visualViewport;
if (vv) {
  // In the installed app on iOS the page starts under the status bar, but 100dvh,
  // innerHeight and the visual viewport all leave the status bar out, which left a
  // gap at the bottom. The screen's own height is right there.
  const iosInstalled = (navigator as { standalone?: boolean }).standalone === true;
  const fullHeight = () => {
    if (!iosInstalled) return window.innerHeight;
    const landscape = window.innerWidth > window.innerHeight;
    return landscape ? Math.min(screen.width, screen.height) : Math.max(screen.width, screen.height);
  };
  const sync = () => {
    if (Math.abs(vv.scale - 1) > 0.01) return; // pinch-zoomed: leave the layout alone
    const root = document.documentElement.style;
    const full = fullHeight();
    if (full - vv.height > 120) {
      root.setProperty("--app-height", `${vv.height}px`);
      // The keyboard covers the home indicator, so no bottom inset while it's up.
      root.setProperty("--safe-bottom", "0px");
    } else {
      // No keyboard: the whole screen (styles.css falls back to 100dvh).
      if (iosInstalled) root.setProperty("--app-height", `${full}px`);
      else root.removeProperty("--app-height");
      root.removeProperty("--safe-bottom");
    }
    if (window.scrollY !== 0) window.scrollTo(0, 0);
  };
  vv.addEventListener("resize", sync);
  vv.addEventListener("scroll", sync);
  window.addEventListener("resize", sync);
  // iOS reports the keyboard's size in steps while it slides in or out, and the
  // last resize can come before it settles; check again as it does.
  const settle = (e: FocusEvent) => {
    const t = e.target as HTMLElement | null;
    if (!t || !(t.matches("input, textarea, select") || t.isContentEditable)) return;
    for (const ms of [50, 150, 300, 500, 800]) setTimeout(sync, ms);
  };
  document.addEventListener("focusin", settle);
  document.addEventListener("focusout", settle);
  sync();
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
