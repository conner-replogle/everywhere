import { expect, test } from "bun:test";
import { Dwell } from "../src/lib/dwell";

test("counts only foreground time, across pauses", () => {
  const d = new Dwell(20_000);
  d.setForeground(true, 0);
  expect(d.elapsed(5_000)).toBe(5_000);
  d.setForeground(false, 8_000);
  // Background time doesn't count.
  expect(d.elapsed(60_000)).toBe(8_000);
  expect(d.done(60_000)).toBe(false);
  d.setForeground(true, 60_000);
  expect(d.remaining(65_000)).toBe(7_000);
  expect(d.done(71_999)).toBe(false);
  expect(d.done(72_000)).toBe(true);
  expect(d.remaining(90_000)).toBe(0);
});

test("starting in the background counts nothing", () => {
  const d = new Dwell(1_000);
  d.setForeground(false, 0);
  expect(d.foreground).toBe(false);
  expect(d.done(10_000)).toBe(false);
});

test("repeated foreground signals don't restart the count", () => {
  const d = new Dwell(1_000);
  d.setForeground(true, 0);
  d.setForeground(true, 500);
  expect(d.elapsed(900)).toBe(900);
  d.setForeground(false, 1_000);
  d.setForeground(false, 2_000);
  expect(d.elapsed(3_000)).toBe(1_000);
});
