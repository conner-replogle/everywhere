import { expect, test } from "bun:test";
import { gamepad, parseHost, Type } from "../src/lib/desktop/protocol";

test("gamepad state matches the daemon's layout", () => {
  const b = new Uint8Array(gamepad(2, { buttons: 0x1000, lt: 1, rt: 7 / 255, lx: 1, ly: -1, rx: 0, ry: 0 }));
  // wire_test.go TestParseGamepad reads the same bytes, bar LY's -32767.
  expect([...b]).toEqual([Type.Gamepad, 2, 1, 0x00, 0x10, 255, 7, 0xff, 0x7f, 0x01, 0x80, 0, 0, 0, 0]);
});

test("an unplugged gamepad sends no state", () => {
  expect([...new Uint8Array(gamepad(3, null))]).toEqual([Type.Gamepad, 3, ...Array(13).fill(0)]);
});

test("rumble and the hello's gamepad flag parse", () => {
  expect(parseHost(new Uint8Array([Type.Rumble, 1, 255, 0]).buffer)).toEqual({ type: Type.Rumble, index: 1, large: 1, small: 0 });
  const hello = new Uint8Array([Type.Hello, 2, 0, 1, 0, 0, 0, 0, 0, 3]);
  expect(parseHost(hello.buffer)).toMatchObject({ moveBy: true, gamepads: true });
});
