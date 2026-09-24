// Turns local DOM input into browser-channel messages for the remote tab.

import { type BrowserClientMsg, BrowserModifier } from "@everywhere/protocol";

export const viewerIsMac = /Mac|iPhone|iPad/.test(navigator.platform);

interface ModifierKeys {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/**
 * The CDP modifier bitmask. A Mac viewer on a non-Mac device gets its ⌘
 * shortcuts as Ctrl ones, so ⌘A/⌘C/⌘Z do there what they do here.
 */
export function modifiers(e: ModifierKeys, remoteMac: boolean): number {
  let m = 0;
  if (e.altKey) m |= BrowserModifier.Alt;
  if (e.shiftKey) m |= BrowserModifier.Shift;
  if (viewerIsMac && !remoteMac) {
    if (e.metaKey || e.ctrlKey) m |= BrowserModifier.Control;
  } else {
    if (e.ctrlKey) m |= BrowserModifier.Control;
    if (e.metaKey) m |= BrowserModifier.Meta;
  }
  return m;
}

/** True when the modifiers make a shortcut rather than typing. */
export function isShortcut(mods: number): boolean {
  return (mods & (BrowserModifier.Control | BrowserModifier.Meta)) !== 0;
}

export function keyMessage(e: KeyboardEvent, kind: "down" | "up", mods: number): BrowserClientMsg {
  let text: string | undefined;
  if (kind === "down" && !isShortcut(mods)) {
    if (e.key === "Enter") text = "\r";
    else if (e.key.length === 1) text = e.key;
  }
  return {
    t: "key",
    kind,
    key: e.key,
    code: e.code,
    keyCode: e.keyCode,
    text,
    location: e.location,
    repeat: e.repeat,
    modifiers: mods,
  };
}

/** A key press with no DOM event behind it (soft keyboards report edits, not keys). */
export function syntheticKey(key: "Backspace" | "Enter"): BrowserClientMsg[] {
  const keyCode = key === "Enter" ? 13 : 8;
  const text = key === "Enter" ? "\r" : undefined;
  return [
    { t: "key", kind: "down", key, code: key, keyCode, text },
    { t: "key", kind: "up", key, code: key, keyCode },
  ];
}

/** Wheel deltas in CSS pixels, whatever unit the event used. */
export function wheelPixels(e: WheelEvent, pageHeight: number): { dx: number; dy: number } {
  const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 40 : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? pageHeight : 1;
  return { dx: e.deltaX * unit, dy: e.deltaY * unit };
}

/**
 * What the user typed in the address bar as a URL: a bare port is localhost
 * on the device, local-looking hosts get http, anything else https.
 */
export function normalizeUrl(input: string): string {
  const s = input.trim();
  if (!s) return "about:blank";
  if (/^\d{2,5}$/.test(s)) return `http://localhost:${s}`;
  if (s === "about:blank" || /^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  if (/^(localhost|127\.|0\.0\.0\.0|\[::1\]|[\w.-]+:\d+(\/|$))/i.test(s)) return `http://${s}`;
  return `https://${s}`;
}

const CSS_CURSORS = new Set([
  "default", "pointer", "text", "vertical-text", "crosshair", "move", "grab", "grabbing", "help", "wait",
  "progress", "not-allowed", "no-drop", "copy", "alias", "cell", "context-menu", "zoom-in", "zoom-out",
  "col-resize", "row-resize", "all-scroll", "none", "n-resize", "e-resize", "s-resize", "w-resize",
  "ne-resize", "nw-resize", "se-resize", "sw-resize", "ew-resize", "ns-resize", "nesw-resize", "nwse-resize",
]);

/** The page's cursor, if it's one we can show (never a url() the page picked). */
export function safeCursor(cursor: string): string {
  return CSS_CURSORS.has(cursor) ? cursor : "default";
}
