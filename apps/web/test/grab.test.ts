import { expect, test } from "bun:test";
import { GrabDetector } from "../src/lib/desktop/grab";

/** Sweeps the pointer across the picture, the host following (or not) after a lag. */
function sweep(g: GrabDetector, follows: boolean, from = 0) {
  for (let t = 0; t <= 1000; t += 16) {
    const x = 0.2 + (0.6 * t) / 1000;
    g.sentMove(x, 0.5, from + t);
    if (follows) g.hostAt({ x: 0.2 + (0.6 * Math.max(0, t - 60)) / 1000, y: 0.5 });
  }
}

test("a host that follows isn't grabbed", () => {
  const g = new GrabDetector();
  sweep(g, true);
  expect(g.grabbed).toBe(false);
});

test("a pointer that stays put while moves are sent is grabbed", () => {
  const g = new GrabDetector();
  g.hostAt({ x: 0.5, y: 0.5 });
  sweep(g, false);
  expect(g.grabbed).toBe(true);
});

test("a hidden pointer counts as grabbed", () => {
  const g = new GrabDetector();
  g.hostAt({ x: 0.5, y: 0.5 });
  g.hostAt(null);
  sweep(g, false);
  expect(g.grabbed).toBe(true);
});

test("the grab ends once moves land again", () => {
  const g = new GrabDetector();
  const changes: boolean[] = [];
  g.onChange = (v) => changes.push(v);
  g.hostAt({ x: 0.5, y: 0.5 });
  sweep(g, false);
  sweep(g, true, 2000);
  expect(changes).toEqual([true, false]);
});

test("a still pointer the host disagrees with isn't a grab (someone at the machine)", () => {
  const g = new GrabDetector();
  g.hostAt({ x: 0.9, y: 0.9 });
  for (let t = 0; t <= 1000; t += 16) g.sentMove(0.3, 0.3, t);
  expect(g.grabbed).toBe(false);
});

test("a host that never reports its pointer is never called grabbed", () => {
  const g = new GrabDetector();
  sweep(g, false);
  expect(g.grabbed).toBe(false);
});
