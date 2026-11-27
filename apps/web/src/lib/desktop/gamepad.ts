import type { DesktopConnection } from "./connection";
import * as proto from "./protocol";

/** The W3C standard mapping's buttons → XInput's button bits. */
const XINPUT_BUTTONS: readonly [number, number][] = [
  [0, 0x1000], // A
  [1, 0x2000], // B
  [2, 0x4000], // X
  [3, 0x8000], // Y
  [4, 0x0100], // left bumper
  [5, 0x0200], // right bumper
  [8, 0x0020], // back / view / share
  [9, 0x0010], // start / menu / options
  [10, 0x0040], // left stick
  [11, 0x0080], // right stick
  [12, 0x0001], // d-pad up
  [13, 0x0002], // d-pad down
  [14, 0x0004], // d-pad left
  [15, 0x0008], // d-pad right
  [16, 0x0400], // guide (where the browser exposes it)
];

/** How often controllers are read while one is connected: about as often as browsers sample them. */
const POLL_MS = 4;
/** How often the page looks for a controller while there are none. */
const IDLE_POLL_MS = 500;
/** The full state goes again this often, so the host recovers from a release-all (the page lost focus). */
const RESEND_MS = 1000;
/** Rumble plays for this long per request, and is renewed while the game keeps it on. */
const RUMBLE_MS = 2000;

const ZERO_STATE: proto.GamepadState = { buttons: 0, lt: 0, rt: 0, lx: 0, ly: 0, rx: 0, ry: 0 };

function readState(p: Gamepad, out: proto.GamepadState): proto.GamepadState {
  let buttons = 0;
  for (const [i, bit] of XINPUT_BUTTONS) if (p.buttons[i]?.pressed) buttons |= bit;
  // Gamepad API sticks have down positive; XInput has up.
  out.buttons = buttons;
  out.lt = p.buttons[6]?.value ?? 0;
  out.rt = p.buttons[7]?.value ?? 0;
  out.lx = p.axes[0] ?? 0;
  out.ly = -(p.axes[1] ?? 0);
  out.rx = p.axes[2] ?? 0;
  out.ry = -(p.axes[3] ?? 0);
  return out;
}

function sameState(a: proto.GamepadState, b: proto.GamepadState): boolean {
  return (
    a.buttons === b.buttons &&
    a.lt === b.lt &&
    a.rt === b.rt &&
    a.lx === b.lx &&
    a.ly === b.ly &&
    a.rx === b.rx &&
    a.ry === b.ry
  );
}

interface Slot {
  /** The browser's Gamepad.index. */
  pad: number;
  last: ArrayBuffer | null;
  lastState: proto.GamepadState | null;
  scratch: proto.GamepadState;
  sentAt: number;
  rumble: { large: number; small: number; at: number } | null;
}

/**
 * Passes the viewer's game controllers to the host, which plugs in an Xbox
 * controller for each: up to four, in the order they first send input
 * (browsers hide a controller until a button on it is pressed). Each one's
 * state is sent when it changes, and the host's rumble comes back to it.
 */
export class GamepadForwarder {
  private slots: (Slot | null)[] = Array.from({ length: proto.MAX_GAMEPADS }, () => null);
  private enabled = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** A controller showed up: its id, and its slot (null while not passing controllers through). */
  onConnect?: (id: string, slot: number | null) => void;
  private detach: (() => void)[] = [];

  constructor(private conn: DesktopConnection) {
    const onConnected = (e: GamepadEvent) => {
      const slot = this.enabled ? this.assign(e.gamepad) : null;
      this.onConnect?.(e.gamepad.id, slot);
      this.schedule(0);
    };
    window.addEventListener("gamepadconnected", onConnected);
    this.detach.push(() => window.removeEventListener("gamepadconnected", onConnected));
    this.schedule(0);
  }

  /** Off unplugs every controller from the host. */
  setEnabled(on: boolean) {
    if (on === this.enabled) return;
    this.enabled = on;
    if (!on) this.unplugAll();
    this.schedule(0);
  }

  /** A game set controller slot's motors (0..1). */
  rumble(slot: number, large: number, small: number) {
    const s = this.slots[slot];
    if (!s) return;
    s.rumble = large || small ? { large, small, at: performance.now() } : null;
    const actuator = this.gamepad(s.pad)?.vibrationActuator;
    if (!actuator) return;
    if (s.rumble) {
      void actuator
        .playEffect("dual-rumble", { duration: RUMBLE_MS, strongMagnitude: large, weakMagnitude: small })
        .catch(() => {});
    } else {
      void actuator.reset().catch(() => {});
    }
  }

  dispose() {
    clearTimeout(this.timer);
    this.unplugAll();
    this.detach.forEach((f) => f());
    this.detach = [];
  }

  private gamepad(index: number): Gamepad | null {
    return navigator.getGamepads?.()[index] ?? null;
  }

  /** The slot for p, given one if it has none and one is free. */
  private assign(p: Gamepad): number | null {
    const have = this.slots.findIndex((s) => s?.pad === p.index);
    if (have >= 0) return have;
    const free = this.slots.indexOf(null);
    if (free < 0) return null;
    this.slots[free] = {
      pad: p.index,
      last: null,
      lastState: null,
      scratch: { ...ZERO_STATE },
      sentAt: 0,
      rumble: null,
    };
    return free;
  }

  private schedule(ms: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.poll(), ms);
  }

  private poll() {
    if (!this.enabled || !navigator.getGamepads) return;
    const pads = navigator.getGamepads();
    // Hidden, the page gets no controller input; the session pauses anyway.
    if (!document.hidden) {
      for (const p of pads) if (p?.connected) this.assign(p);
    }
    const now = performance.now();
    let any = false;
    this.slots.forEach((s, slot) => {
      if (!s) return;
      const p = pads[s.pad];
      if (!p?.connected) {
        this.slots[slot] = null;
        this.send(proto.gamepad(slot, null));
        return;
      }
      any = true;
      const state = document.hidden ? ZERO_STATE : readState(p, s.scratch);
      const due = now - s.sentAt > RESEND_MS;
      // Fast zero-allocation path while the controller is idle between resends.
      if (!due && s.lastState && sameState(state, s.lastState)) {
        if (s.rumble && now - s.rumble.at > RUMBLE_MS - 500) this.rumble(slot, s.rumble.large, s.rumble.small);
        return;
      }
      const msg = proto.gamepad(slot, state);
      if (!s.last || !sameBytes(msg, s.last) || due) {
        if (this.send(msg)) {
          s.last = msg;
          if (!s.lastState) s.lastState = { ...state };
          else Object.assign(s.lastState, state);
          s.sentAt = now;
        }
      } else {
        if (!s.lastState) s.lastState = { ...state };
        else Object.assign(s.lastState, state);
      }
      if (s.rumble && now - s.rumble.at > RUMBLE_MS - 500) this.rumble(slot, s.rumble.large, s.rumble.small);
    });
    this.schedule(any ? POLL_MS : IDLE_POLL_MS);
  }

  private unplugAll() {
    this.slots.forEach((s, slot) => {
      if (!s) return;
      this.send(proto.gamepad(slot, null));
      void this.gamepad(s.pad)?.vibrationActuator?.reset().catch(() => {});
    });
    this.slots.fill(null);
  }

  private send(msg: ArrayBuffer): boolean {
    if (this.conn.control.readyState !== "open") return false;
    this.conn.control.send(msg);
    return true;
  }
}

function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a), y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}
