// Mobile browsers freeze a backgrounded page and may drop its sockets without
// telling it, and the network can change meanwhile. When the page comes back,
// check the hub socket and every device connection instead of waiting for
// pings and ICE timeouts to notice.

import { hub } from "./hub";
import { checkPeersAlive } from "./peer";

/** Shorter trips away (switching tabs on a desktop) don't need a check. */
const AWAY_MS = 10_000;

function check() {
  hub.checkAlive();
  checkPeersAlive();
}

/** Starts watching; returns a function that stops. */
export function watchResume(): () => void {
  let hiddenAt: number | null = document.visibilityState === "hidden" ? Date.now() : null;
  const onVisibility = () => {
    if (document.visibilityState === "hidden") {
      hiddenAt ??= Date.now();
      return;
    }
    const away = hiddenAt === null ? 0 : Date.now() - hiddenAt;
    hiddenAt = null;
    if (away >= AWAY_MS) check();
  };
  // Restored from the back/forward cache: everything was frozen.
  const onPageShow = (e: PageTransitionEvent) => {
    if (e.persisted) check();
  };
  window.addEventListener("online", check);
  window.addEventListener("pageshow", onPageShow);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    window.removeEventListener("online", check);
    window.removeEventListener("pageshow", onPageShow);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
