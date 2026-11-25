import { describe, expect, test } from "bun:test";
import { cellRects, type Grid, parseGrid, withBeside, withoutCell, withShown } from "../src/lib/thread-grid";

const empty: Grid = { cells: [], focus: "", x: 0.5, y: 0.5 };
const ids = (g: Grid) => g.cells.map((c) => c.threadId);
const focused = (g: Grid) => g.cells.find((c) => c.id === g.focus)?.threadId;

describe("withShown", () => {
  test("the first thread makes the first cell", () => {
    const g = withShown(empty, { deviceId: "d", threadId: "a" });
    expect(ids(g)).toEqual(["a"]);
    expect(focused(g)).toBe("a");
  });

  test("another thread replaces the focused cell's, keeping the cell", () => {
    const g1 = withShown(empty, { deviceId: "d", threadId: "a" });
    const g2 = withShown(g1, { deviceId: "d", threadId: "b", tab: "t1" });
    expect(ids(g2)).toEqual(["b"]);
    expect(g2.cells[0]!.id).toBe(g1.cells[0]!.id);
    expect(g2.cells[0]!.tab).toBe("t1");
  });

  test("a thread already in a cell takes the focus there", () => {
    let g = withShown(empty, { deviceId: "d", threadId: "a" });
    g = withBeside(g, "d", "b");
    expect(focused(g)).toBe("b");
    g = withShown(g, { deviceId: "d", threadId: "a" });
    expect(ids(g)).toEqual(["a", "b"]);
    expect(focused(g)).toBe("a");
  });

  test("nothing new is the same grid", () => {
    const g = withShown(empty, { deviceId: "d", threadId: "a" });
    expect(withShown(g, { deviceId: "d", threadId: "a" })).toBe(g);
  });

  test("the same thread id on another device is another thread", () => {
    let g = withShown(empty, { deviceId: "d1", threadId: "a" });
    g = withBeside(g, "d2", "a");
    expect(g.cells.length).toBe(2);
  });
});

describe("withBeside", () => {
  test("adds up to four, then replaces the one unused longest", () => {
    let g = withShown(empty, { deviceId: "d", threadId: "a" }, 1);
    g = withBeside(g, "d", "b", 2);
    g = withBeside(g, "d", "c", 3);
    g = withBeside(g, "d", "d", 4);
    expect(ids(g)).toEqual(["a", "b", "c", "d"]);
    g = withBeside(g, "d", "e", 5);
    expect(ids(g)).toEqual(["e", "b", "c", "d"]);
    expect(focused(g)).toBe("e");
  });

  test("never replaces the focused cell", () => {
    let g = withShown(empty, { deviceId: "d", threadId: "a" }, 10);
    g = withBeside(g, "d", "b", 2);
    g = withBeside(g, "d", "c", 3);
    g = withBeside(g, "d", "d", 4);
    // d is focused (usedAt 4); a was used last at 10, b at 2.
    g = withBeside(g, "d", "e", 5);
    expect(ids(g)).toEqual(["a", "e", "c", "d"]);
  });
});

describe("withoutCell", () => {
  test("the most recently used cell takes the focus", () => {
    let g = withShown(empty, { deviceId: "d", threadId: "a" }, 1);
    g = withBeside(g, "d", "b", 3);
    g = withBeside(g, "d", "c", 2);
    g = withoutCell(g, g.focus);
    expect(ids(g)).toEqual(["a", "b"]);
    expect(focused(g)).toBe("b");
  });
});

describe("parseGrid", () => {
  test("drops what doesn't fit", () => {
    const g = parseGrid({ cells: [{ id: "x", deviceId: "d", threadId: "a" }, { nope: 1 }], focus: "gone", x: 5 });
    expect(ids(g)).toEqual(["a"]);
    expect(g.focus).toBe("x");
    expect(g.x).toBe(0.5);
  });
});

describe("cellRects", () => {
  test("cover the grid without overlap", () => {
    for (const n of [1, 2, 3, 4]) {
      const area = cellRects(n, 0.3, 0.6).reduce((a, r) => a + r.width * r.height, 0);
      expect(area).toBeCloseTo(1);
    }
  });
});
