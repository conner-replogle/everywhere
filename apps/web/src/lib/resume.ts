// Mobile browsers freeze a backgrounded page and may drop its sockets without
// telling it, and the network can change meanwhile. When the page comes back,
// or the network changes, check the hub socket and every device connection
// instead of waiting for pings and ICE timeouts to notice. How long the page
// was away decides how: see hub.checkAlive and DevicePeer.checkAlive.

import { hub } from "./hub";
import { checkPeersAlive } from "./peer";
import { inIOSApp } from "./pwa";

/** Shorter trips away (switching tabs on a desktop) don't need a check. */
const AWAY_MS = 10_000;

/**
 * Phones and tablets freeze a page in the background: its sockets and routes
 * may be gone without a word. A desktop tab keeps running, and its
 * connections notice trouble themselves.
 */
const freezes = inIOSApp || matchMedia("(pointer: coarse)").matches;

/** awayMs: how long the page was away; 0 for a network change (every route may be gone). */
function check(awayMs: number) {
  const network = awayMs === 0;
  hub.checkAlive(network ? Infinity : freezes ? awayMs : 0);
  checkPeersAlive(awayMs, network || freezes);
}

const onOnline = () => check(0);

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
    if (away >= AWAY_MS) check(away);
  };
  // Restored from the back/forward cache: everything was frozen.
  const onPageShow = (e: PageTransitionEvent) => {
    // Frozen for who knows how long, on any device: make new connections.
    if (e.persisted) {
      hub.checkAlive(Infinity);
      checkPeersAlive(Infinity, true);
    }
  };
  window.addEventListener("online", onOnline);
  window.addEventListener("pageshow", onPageShow);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    window.removeEventListener("online", onOnline);
    window.removeEventListener("pageshow", onPageShow);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}
