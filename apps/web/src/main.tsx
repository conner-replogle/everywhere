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
  const sync = () => {
    if (Math.abs(vv.scale - 1) > 0.01) return; // pinch-zoomed: leave the layout alone
    const root = document.documentElement.style;
    // Otherwise the app fills the screen (styles.css): the visual viewport can
    // stay short after the keyboard goes away.
    if (window.innerHeight - vv.height > 120) {
      root.setProperty("--app-height", `${vv.height}px`);
      // The keyboard covers the home indicator, so no bottom inset while it's up.
      root.setProperty("--safe-bottom", "0px");
    } else {
      root.removeProperty("--app-height");
      root.removeProperty("--safe-bottom");
    }
    if (window.scrollY !== 0) window.scrollTo(0, 0);
  };
  vv.addEventListener("resize", sync);
  vv.addEventListener("scroll", sync);
  window.addEventListener("resize", sync);
  sync();
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
