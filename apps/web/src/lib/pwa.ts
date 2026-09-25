// Installable app: registers the service worker and keeps the browser's
// install prompt so the UI can offer "Install app" (Chromium only; Safari
// installs through Share → Add to Home Screen).

import { useSyncExternalStore } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let installPrompt: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};

export function registerServiceWorker() {
  // Not in dev: it would cache Vite's modules and fight HMR.
  if (import.meta.env.PROD && "serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch((err) => console.warn("service worker:", err));
  }
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // we offer it from the account menu instead of the mini-infobar
    installPrompt = e as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    notify();
  });
}

/** Shows the browser's install dialog, or null when it can't (unsupported or already installed). */
export function useInstallApp(): (() => Promise<void>) | null {
  const prompt = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => installPrompt,
  );
  if (!prompt) return null;
  return async () => {
    await prompt.prompt();
    await prompt.userChoice;
    installPrompt = null; // a prompt can only be shown once
    notify();
  };
}
