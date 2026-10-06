import type { Thread } from "@everywhere/protocol";
import { expect, test } from "bun:test";
import { IDLE_AFTER_MS, isBusy, isIdle, lastTouched } from "../src/lib/idle-threads";

const NOW = Date.UTC(2026, 9, 6);
const DAY = 24 * 60 * 60 * 1000;

const thread = (over: Partial<Thread> = {}): Thread => ({
  id: "t1",
  projectId: "p1",
  kind: "terminal",
  name: "shell",
  createdAt: NOW - 10 * DAY,
  lastOpenedAt: null,
  running: false,
  ...over,
});

test("the idle threshold is three days", () => {
  expect(IDLE_AFTER_MS).toBe(3 * DAY);
});

test("last touched is the latest of lastOpenedAt, createdAt and a local touch", () => {
  expect(lastTouched(thread())).toBe(NOW - 10 * DAY);
  expect(lastTouched(thread({ lastOpenedAt: NOW - 2 * DAY }))).toBe(NOW - 2 * DAY);
  expect(lastTouched(thread({ lastOpenedAt: NOW - 5 * DAY }), NOW - DAY)).toBe(NOW - DAY);
});

test("missing or bad timestamps are ignored, and a thread with none never goes idle", () => {
  const bad = thread({ createdAt: Number.NaN, lastOpenedAt: null });
  expect(lastTouched(bad)).toBeUndefined();
  expect(isIdle(bad, NOW)).toBe(false);
  expect(isIdle(thread({ createdAt: 0 }), NOW)).toBe(false);
  // A good local touch still counts.
  expect(lastTouched(bad, NOW - 4 * DAY)).toBe(NOW - 4 * DAY);
});

test("a thread goes idle exactly three days after it was last touched", () => {
  expect(isIdle(thread({ lastOpenedAt: NOW - 3 * DAY + 1 }), NOW)).toBe(false);
  expect(isIdle(thread({ lastOpenedAt: NOW - 3 * DAY }), NOW)).toBe(true);
  expect(isIdle(thread(), NOW)).toBe(true);
});

test("opening a thread in this browser keeps it listed", () => {
  expect(isIdle(thread(), NOW, NOW - DAY)).toBe(false);
});

test("timestamps in the future (clock skew) don't hide a thread", () => {
  expect(isIdle(thread({ lastOpenedAt: NOW + DAY }), NOW)).toBe(false);
});

test("busy threads never go idle", () => {
  expect(isBusy(thread({ running: true }))).toBe(true);
  for (const agentStatus of ["working", "starting", "waiting"] as const) {
    expect(isIdle(thread({ kind: "claude", agentStatus }), NOW)).toBe(false);
  }
  expect(isIdle(thread({ processes: 1 }), NOW)).toBe(false);
  expect(isIdle(thread({ running: true }), NOW)).toBe(false);
  // Stopped or idle claude threads can go idle.
  expect(isIdle(thread({ kind: "claude", agentStatus: "idle" }), NOW)).toBe(true);
  expect(isIdle(thread({ kind: "claude", agentStatus: "stopped" }), NOW)).toBe(true);
});

test("archived threads are left to the Archived section", () => {
  expect(isIdle(thread({ archivedAt: NOW - 9 * DAY }), NOW)).toBe(false);
});
