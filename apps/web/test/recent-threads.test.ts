import { expect, test } from "bun:test";
import { isInputKey, normalize, type RecentThread, withRetain, withVisit } from "../src/lib/recent-threads";

const T = { name: "t", kind: "terminal" as const };
const ids = (l: readonly RecentThread[]) => l.map((r) => `${r.threadId}${r.preview ? "*" : ""}`);

test("opening threads reuses one preview tab", () => {
  let l = withVisit([], "d", "a", T, { now: 1 });
  expect(ids(l)).toEqual(["a*"]);
  l = withVisit(l, "d", "b", T, { now: 2 });
  expect(ids(l)).toEqual(["b*"]);
  l = withVisit(l, "d", "c", T, { now: 3 });
  expect(ids(l)).toEqual(["c*"]);
});

test("the preview is replaced in place, and kept tabs are left alone", () => {
  let l = withVisit([], "d", "a", T, { now: 1, retain: true });
  l = withVisit(l, "d", "b", T, { now: 2 });
  l = withVisit(l, "d", "c", T, { now: 3, retain: true });
  expect(ids(l)).toEqual(["a", "b*", "c"]);
  l = withVisit(l, "d", "x", T, { now: 4 });
  expect(ids(l)).toEqual(["a", "x*", "c"]);
});

test("opening a thread that has a tab focuses it without duplicating or changing it", () => {
  let l = withVisit([], "d", "a", T, { now: 1, retain: true });
  l = withVisit(l, "d", "b", T, { now: 2 });
  l = withVisit(l, "d", "a", { name: "renamed", kind: "terminal" }, { now: 3 });
  expect(ids(l)).toEqual(["a", "b*"]);
  expect(l[0]!.name).toBe("renamed");
  l = withVisit(l, "d", "b", T, { now: 4 });
  expect(ids(l)).toEqual(["a", "b*"]);
});

test("same thread id on another device is another tab", () => {
  let l = withVisit([], "d1", "a", T, { now: 1, retain: true });
  l = withVisit(l, "d2", "a", T, { now: 2 });
  expect(l.map((r) => `${r.deviceId}/${r.threadId}`)).toEqual(["d1/a", "d2/a"]);
});

test("retaining keeps the preview, so the next thread opens a new preview", () => {
  let l = withVisit([], "d", "a", T, { now: 1 });
  l = withRetain(l, "d", "a");
  expect(ids(l)).toEqual(["a"]);
  l = withVisit(l, "d", "b", T, { now: 2 });
  expect(ids(l)).toEqual(["a", "b*"]);
});

test("retaining is a no-op for kept or unknown tabs, unless the thread is given", () => {
  const l = withVisit([], "d", "a", T, { now: 1, retain: true });
  expect(withRetain(l, "d", "a")).toBe(l);
  expect(withRetain(l, "d", "zz")).toBe(l);
  expect(ids(withRetain(l, "d", "b", T))).toEqual(["a", "b"]);
});

test("retain on visit turns an existing preview into a kept tab", () => {
  let l = withVisit([], "d", "a", T, { now: 1 });
  l = withVisit(l, "d", "a", T, { now: 2, retain: true });
  expect(ids(l)).toEqual(["a"]);
});

test("entries from before previews are kept tabs", () => {
  const old = [{ deviceId: "d", threadId: "a", name: "a", kind: "terminal", visitedAt: 1 }] as RecentThread[];
  expect(ids(withVisit(old, "d", "b", T, { now: 2 }))).toEqual(["a", "b*"]);
});

test("over the limit, the preview goes first, then the least recently visited", () => {
  let l: RecentThread[] = [];
  l = withVisit(l, "d", "a", T, { now: 1, retain: true, max: 3 });
  l = withVisit(l, "d", "b", T, { now: 2, retain: true, max: 3 });
  l = withVisit(l, "d", "p", T, { now: 3, max: 3 });
  l = withVisit(l, "d", "c", T, { now: 4, retain: true, max: 3 });
  expect(ids(l)).toEqual(["a", "b", "c"]);
  l = withVisit(l, "d", "e", T, { now: 5, retain: true, max: 3 });
  expect(ids(l)).toEqual(["b", "c", "e"]);
  // The tab being opened is never the one dropped.
  l = withVisit(l, "d", "f", T, { now: 6, max: 3 });
  expect(ids(l)).toEqual(["c", "e", "f*"]);
});

test("normalize leaves at most one preview, the most recent", () => {
  const l = normalize([
    { deviceId: "d", threadId: "a", name: "a", kind: "terminal", visitedAt: 5, preview: true },
    { deviceId: "d", threadId: "b", name: "b", kind: "terminal", visitedAt: 9, preview: true },
  ]);
  expect(ids(l)).toEqual(["a", "b*"]);
});

test("input keys", () => {
  const k = (key: string, m: Partial<Record<"metaKey" | "ctrlKey" | "shiftKey", boolean>> = {}) =>
    isInputKey({ key, metaKey: false, ctrlKey: false, shiftKey: false, ...m });
  expect(k("a")).toBe(true);
  expect(k("Enter")).toBe(true);
  expect(k("ArrowUp")).toBe(true);
  expect(k("c", { ctrlKey: true })).toBe(true); // ^C to the shell
  expect(k("Unidentified")).toBe(true); // phone keyboards
  expect(k("Shift", { shiftKey: true })).toBe(false);
  expect(k("Control", { ctrlKey: true })).toBe(false);
  expect(k("Tab", { metaKey: true })).toBe(false);
  expect(k("C", { ctrlKey: true, shiftKey: true })).toBe(false); // copy
});
