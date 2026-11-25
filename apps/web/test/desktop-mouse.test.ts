import { beforeEach, describe, expect, test } from "bun:test";

// Just enough of the DOM for InputForwarder: listeners, and a pointer lock
// the test can grant, refuse, or end as the viewer would.
type Listener = (e: unknown) => void;
class Target {
  listeners = new Map<string, Listener[]>();
  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener() {}
  fire(type: string, e: unknown = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }
}

class FakeDocument extends Target {
  pointerLockElement: unknown = null;
  hidden = false;
  exits = 0;
  hasFocus() {
    return true;
  }
  exitPointerLock() {
    this.exits++;
    this.setLock(null);
  }
  setLock(el: unknown) {
    this.pointerLockElement = el;
    this.fire("pointerlockchange");
  }
}

const doc = new FakeDocument();
Object.assign(globalThis, { document: doc, window: new Target() });

const { InputForwarder } = await import("../src/lib/desktop/input");
const { Type } = await import("../src/lib/desktop/protocol");

class FakeVideo extends Target {
  locks = 0;
  /** Whether the browser grants the lock (a gesture, or a page that let it go itself). */
  grant = true;
  requestPointerLock() {
    this.locks++;
    if (!this.grant) return Promise.reject(new Error("needs a gesture"));
    doc.setLock(this);
    return Promise.resolve();
  }
  setPointerCapture() {}
  get videoWidth() {
    return 100;
  }
  get videoHeight() {
    return 100;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 100, height: 100 };
  }
}

const channel = () => ({ readyState: "open", sent: [] as ArrayBuffer[], send(b: ArrayBuffer) { this.sent.push(b); } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = () => sleep(10);

function setup(relative = true) {
  doc.pointerLockElement = null;
  doc.listeners.clear();
  doc.exits = 0;
  const video = new FakeVideo();
  const conn = { control: channel(), input: channel() };
  const fwd = new InputForwarder(video as never, conn as never, { superSubstitute: null, keyTarget: new Target() as never });
  fwd.setRelative(relative);
  return { video, conn, fwd };
}

const pointer = (video: FakeVideo, type: string, extra: object = {}) =>
  video.fire(type, { pointerType: "mouse", button: 0, clientX: 10, clientY: 10, pointerId: 1, preventDefault() {}, ...extra });
const click = (video: FakeVideo, pressed: boolean) => pointer(video, pressed ? "pointerdown" : "pointerup");
const types = (ch: { sent: ArrayBuffer[] }) => ch.sent.map((b) => new DataView(b).getUint8(0));

describe("the mouse, as the host's own", () => {
  beforeEach(() => doc.listeners.clear());

  test("it does nothing on the host until a click captures it", async () => {
    const { video, conn } = setup();
    pointer(video, "pointermove");
    expect(conn.input.sent.length + conn.control.sent.length).toBe(0);
    click(video, true);
    await settle();
    expect(doc.pointerLockElement).toBe(video);
  });

  test("the capturing click lands where it was clicked; its release, where the pointer is", async () => {
    const { video, conn } = setup();
    click(video, true);
    await settle();
    expect(types(conn.control)).toEqual([Type.Button]);
    expect(new DataView(conn.control.sent[0]!).getUint16(3, true)).toBe(Math.round(0.1 * 65535));
    click(video, false);
    expect(types(conn.control).slice(1)).toEqual([Type.MoveBy, Type.Button]);
  });

  test("captured, it sends its motion, and buttons press where the pointer is", async () => {
    const { video, conn } = setup();
    click(video, true);
    click(video, false);
    await settle();
    conn.control.sent.length = 0;
    pointer(video, "pointermove", { movementX: 3, movementY: -2 });
    click(video, true);
    expect(types(conn.control)).toEqual([Type.MoveBy, Type.Button]);
    const m = new DataView(conn.control.sent[0]!);
    expect([m.getFloat32(1, true), m.getFloat32(5, true)]).toEqual([3, -2]);
    expect(conn.input.sent.length).toBe(0);
  });

  test("a game that hid the pointer gets the capturing click where its pointer is, with no jump", async () => {
    const { video, conn, fwd } = setup();
    fwd.setHostCaptured(true);
    click(video, true);
    expect(types(conn.control)).toEqual([Type.MoveBy, Type.Button]);
    expect(conn.input.sent.length).toBe(0);
  });

  test("let go (Esc), the next click captures it again", async () => {
    const { video } = setup();
    click(video, true);
    await settle();
    doc.setLock(null);
    click(video, true);
    await settle();
    expect(doc.pointerLockElement).toBe(video);
  });

  test("view only lets it go; without relative motion it points", async () => {
    const { video, fwd } = setup();
    click(video, true);
    await settle();
    fwd.setViewOnly(true);
    expect(doc.pointerLockElement).toBe(null);

    const pointing = setup(false);
    pointer(pointing.video, "pointermove");
    click(pointing.video, true);
    await settle();
    expect(doc.pointerLockElement).toBe(null);
    expect(types(pointing.conn.input)).toEqual([Type.Move]);
    expect(types(pointing.conn.control)).toEqual([Type.Button]);
  });
});
