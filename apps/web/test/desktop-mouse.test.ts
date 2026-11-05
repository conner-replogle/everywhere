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

function setup(mode: "auto" | "game" | "desktop" = "auto") {
  doc.pointerLockElement = null;
  doc.listeners.clear();
  doc.exits = 0;
  const video = new FakeVideo();
  const conn = { control: channel(), input: channel() };
  const fwd = new InputForwarder(video as never, conn as never, { superSubstitute: null, keyTarget: new Target() as never });
  fwd.setMode(mode);
  const relative: boolean[] = [];
  fwd.onRelativeChange = (r) => relative.push(r);
  return { video, conn, fwd, relative };
}

const click = (video: FakeVideo, pressed: boolean) =>
  video.fire(pressed ? "pointerdown" : "pointerup", { pointerType: "mouse", button: 0, clientX: 10, clientY: 10, pointerId: 1, preventDefault() {} });

describe("auto mouse", () => {
  beforeEach(() => doc.listeners.clear());

  test("a hidden host pointer makes the mouse relative, after a moment; the first capture takes a click", async () => {
    const { video, fwd, relative } = setup();
    video.grant = false; // no click yet
    fwd.setHostCaptured(true);
    expect(fwd.relative).toBe(false);
    await sleep(150);
    expect(fwd.relative).toBe(true);
    expect(relative).toEqual([true]);
    await settle();
    expect(doc.pointerLockElement).toBe(null);

    video.grant = true;
    click(video, true);
    await settle();
    expect(doc.pointerLockElement).toBe(video);
  });

  test("the pointer coming back lets the mouse go, and hiding again takes it back without a click", async () => {
    const { video, fwd } = setup();
    fwd.setHostCaptured(true);
    await sleep(150);
    click(video, true);
    await settle();
    expect(doc.pointerLockElement).toBe(video);

    fwd.setHostCaptured(false);
    await sleep(300);
    expect(fwd.relative).toBe(false);
    expect(doc.pointerLockElement).toBe(null);

    const before = video.locks;
    fwd.setHostCaptured(true);
    await sleep(150);
    await settle();
    expect(video.locks).toBe(before + 1);
    expect(doc.pointerLockElement).toBe(video);
  });

  test("a pointer that flickers doesn't let go", async () => {
    const { video, fwd } = setup();
    fwd.setHostCaptured(true);
    await sleep(150);
    click(video, true);
    await settle();
    fwd.setHostCaptured(false);
    await sleep(50);
    fwd.setHostCaptured(true);
    await sleep(300);
    expect(doc.exits).toBe(0);
    expect(doc.pointerLockElement).toBe(video);
  });

  test("after the viewer lets go (Esc), auto waits for a click", async () => {
    const { video, fwd } = setup();
    fwd.setHostCaptured(true);
    await sleep(150);
    click(video, true);
    await settle();
    doc.setLock(null); // the viewer pressed Esc
    fwd.setHostCaptured(false);
    await sleep(300);
    const before = video.locks;
    fwd.setHostCaptured(true);
    await sleep(150);
    await settle();
    expect(video.locks).toBe(before);
    click(video, true);
    await settle();
    expect(doc.pointerLockElement).toBe(video);
  });

  test("the capturing click reaches the game where its pointer is", async () => {
    const { video, conn, fwd } = setup();
    video.grant = false;
    fwd.setHostCaptured(true);
    await sleep(150);
    click(video, true);
    const types = conn.control.sent.map((b) => new DataView(b).getUint8(0));
    expect(types).toContain(Type.MoveBy);
    expect(types.indexOf(Type.MoveBy)).toBeLessThan(types.indexOf(Type.Button));
  });

  test("game mode keeps the capturing click, desktop mode ignores the host", async () => {
    const game = setup("game");
    game.video.grant = false;
    click(game.video, true);
    expect(game.conn.control.sent.some((b) => new DataView(b).getUint8(0) === Type.Button)).toBe(false);

    const desk = setup("desktop");
    desk.fwd.setHostCaptured(true);
    await sleep(150);
    expect(desk.fwd.relative).toBe(false);
  });
});
