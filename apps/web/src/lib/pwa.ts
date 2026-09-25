// Installable app: registers the service worker and keeps the browser's
// install prompt so the UI can offer "Install app" (Chromium only; Safari
// installs through Share → Add to Home Screen). Also push notifications,
// which the service worker shows.

import { useSyncExternalStore } from "react";
import { api } from "./api";

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

// --- push notifications ---------------------------------------------------------------

/**
 * Whether this browser can get push notifications: "ok"; "install" on iOS,
 * which only allows them once the app is on the home screen; or "unsupported".
 */
export function pushSupport(): "ok" | "install" | "unsupported" {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  if (ios && !isStandalone()) return "install";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
  return "ok";
}

function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** The service worker, or null without one (dev, or unsupported). */
async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

/** This browser's push subscription, if notifications are on. */
export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== "ok" || Notification.permission !== "granted") return null;
  return (await (await registration())?.pushManager.getSubscription()) ?? null;
}

/** Asks for permission, subscribes, and registers the subscription with the Worker. */
export async function enablePush(): Promise<PushSubscription> {
  const reg = await registration();
  if (!reg) throw new Error("Notifications need the installed app's service worker (not available in development).");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(
      permission === "denied"
        ? "Notifications are blocked for this site. Allow them in the browser's site settings."
        : "Notifications weren't allowed.",
    );
  }
  const sub = await subscribe(reg, await api.pushKey());
  await api.subscribePush(sub.toJSON());
  return sub;
}

export async function disablePush(): Promise<void> {
  const sub = await (await registration())?.pushManager.getSubscription();
  if (!sub) return;
  await api.unsubscribePush(sub.endpoint).catch(() => {});
  await sub.unsubscribe();
}

/**
 * Re-registers this browser's subscription after sign-in (a subscription dies
 * with the session that made it), resubscribing if the server's key changed.
 */
export async function syncPushSubscription(): Promise<void> {
  const reg = await registration();
  let sub = await currentPushSubscription();
  if (!reg || !sub) return;
  const key = await api.pushKey();
  const current = sub.options.applicationServerKey;
  if (!current || b64url(new Uint8Array(current)) !== key) {
    await sub.unsubscribe();
    sub = await subscribe(reg, key);
  }
  await api.subscribePush(sub.toJSON());
}

function subscribe(reg: ServiceWorkerRegistration, key: string): Promise<PushSubscription> {
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64url(key) });
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
}
