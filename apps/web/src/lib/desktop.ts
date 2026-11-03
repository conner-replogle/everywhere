// The desktop app (apps/desktop), when the web app runs in it: its bridge,
// and the <webview> element web tabs are made of. In a browser, desktop is
// undefined and web tabs say they need the app.

import type { DesktopBridge } from "@everywhere/protocol";

export const desktop: DesktopBridge | undefined = (window as { everywhereDesktop?: DesktopBridge }).everywhereDesktop;

/** The parts of Electron's <webview> element web tabs use. */
export interface WebviewElement extends HTMLElement {
  src: string;
  getWebContentsId(): number;
  getURL(): string;
  getTitle(): string;
  loadURL(url: string): Promise<void>;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  reloadIgnoringCache(): void;
  stop(): void;
  isLoading(): boolean;
  setZoomLevel(level: number): void;
  getZoomLevel(): number;
  findInPage(text: string, options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }): number;
  stopFindInPage(action: "clearSelection" | "keepSelection" | "activateSelection"): void;
  focus(): void;
}

/** The events of a <webview> web tabs listen to, with what they carry. */
export interface WebviewEvents {
  "dom-ready": Event;
  "did-start-loading": Event;
  "did-stop-loading": Event;
  "did-navigate": Event & { url: string };
  "did-navigate-in-page": Event & { url: string; isMainFrame: boolean };
  "did-fail-load": Event & { errorCode: number; errorDescription: string; validatedURL: string; isMainFrame: boolean };
  "page-title-updated": Event & { title: string };
  "page-favicon-updated": Event & { favicons: string[] };
  "found-in-page": Event & { result: { requestId: number; activeMatchOrdinal: number; matches: number; finalUpdate: boolean } };
  "render-process-gone": Event & { details: { reason: string } };
}

export function onWebview<K extends keyof WebviewEvents>(
  el: WebviewElement,
  type: K,
  fn: (e: WebviewEvents[K]) => void,
): () => void {
  const listener = (e: Event) => fn(e as WebviewEvents[K]);
  el.addEventListener(type, listener);
  return () => el.removeEventListener(type, listener);
}
