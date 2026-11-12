import type { Thread } from "@everywhere/protocol";
import { expect, test } from "bun:test";
import { completeHit, highlight, mergeResults, searchNames, searchTerms } from "../src/lib/search";
import { formatShortcut, matches, parseShortcut, recordShortcut } from "../src/lib/shortcut";

const NOW = Date.UTC(2026, 10, 11);
const DAY = 86_400_000;
const thread = (over: Partial<Thread>): Thread => ({ id: "t", projectId: "p", kind: "claude", name: "n", createdAt: NOW, lastOpenedAt: null, running: false, ...over }) as Thread;

test("terms are words and quoted phrases", () => {
  expect(searchTerms(`  foo "bar baz" qux "open`)).toEqual(["foo", "bar baz", "qux", "open"]);
  expect(searchTerms("   ")).toEqual([]);
});

test("highlight marks every term, case-insensitively, merging overlaps", () => {
  expect(highlight("Fix the Keyring key", ["key", "keyring"])).toEqual([
    { text: "Fix the ", match: false },
    { text: "Keyring", match: true },
    { text: " ", match: false },
    { text: "key", match: true },
  ]);
  expect(highlight("abc", [])).toEqual([{ text: "abc", match: false }]);
});

test("old daemons' hits are filled in from the thread list and ranked by recency", () => {
  const threads = [thread({ id: "a", name: "alpha", pinnedAt: 1 })];
  const h = completeHit({ threadId: "a", at: NOW - DAY, snippet: "x" }, threads, NOW)!;
  expect(h.name).toBe("alpha");
  expect(h.pinnedAt).toBe(1);
  expect(h.score).toBeGreaterThan(0.3);
  expect(completeHit({ threadId: "gone", at: NOW }, threads, NOW)).toBeUndefined();
});

test("names only: every term", () => {
  const threads = [thread({ id: "a", name: "Deploy pipeline" }), thread({ id: "b", name: "deploy" }), thread({ id: "c", name: "other" })];
  expect(searchNames(threads, "pipe DEPLOY", NOW).map((h) => h.threadId)).toEqual(["a"]);
});

test("results merge best first, then newest", () => {
  const r = (deviceId: string, score: number, at: number) => ({ deviceId, hit: { threadId: deviceId, name: "", score, at } });
  expect(mergeResults([r("a", 0.2, 5), r("b", 0.9, 1), r("c", 0.2, 9)]).map((x) => x.deviceId)).toEqual(["b", "c", "a"]);
});

const key = (k: Partial<KeyboardEvent>) => ({ key: "", code: "", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...k });

test("shortcuts parse, match by key position, and show per platform", () => {
  const c = parseShortcut("Mod+Shift+F", false)!;
  expect([...c.mods].sort()).toEqual(["Ctrl", "Shift"]);
  expect(matches(key({ key: "F", code: "KeyF", ctrlKey: true, shiftKey: true }), c)).toBe(true);
  expect(matches(key({ key: "f", code: "KeyF", ctrlKey: true }), c)).toBe(false);
  // Alt changes e.key on a Mac; the code still says K.
  expect(matches(key({ key: "˚", code: "KeyK", altKey: true }), parseShortcut("Alt+K")!)).toBe(true);
  expect(parseShortcut("Hyper+K")).toBeUndefined();
  expect(formatShortcut("Meta+K", true)).toBe("⌘K");
  expect(formatShortcut("Ctrl+Shift+F", false)).toBe("Ctrl+Shift+F");
});

test("recording takes a key with a modifier, not plain typing", () => {
  expect(recordShortcut(key({ key: "k", code: "KeyK" }))).toBeUndefined();
  expect(recordShortcut(key({ key: "Control", code: "ControlLeft", ctrlKey: true }))).toBeUndefined();
  expect(recordShortcut(key({ key: "P", code: "KeyP", ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+P");
});
