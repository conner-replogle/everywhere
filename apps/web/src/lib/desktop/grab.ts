/** How long after a move the host's cursor report should show it, beyond the round trip. */
const LAG_MS = 150;
/** The host pointer this far (0..1 of the picture) from where it was sent has gone there. */
const HIT = 0.02;
/** The pointer was sent somewhere new when it went this far between checks. */
const MOVING = 0.015;
/** Where it was sent this long before is still a place the host may be catching up with. */
const MOVE_WINDOW_MS = 300;
/** Checks in a row that miss while the pointer moves before calling it a grab; and that land, to end one. */
const MISSES = 3;
const HITS = 3;
/** Checks are at most this often, so MISSES spans a moment of motion. */
const CHECK_MS = 100;
/** The host pointer moved since the last check: a grabbed one doesn't. */
const HOST_MOVED = 0.005;

interface Point {
  x: number;
  y: number;
}

/**
 * Tells when an app on the host has grabbed the pointer, as a game does: the
 * pointer stops going where it's sent. The host can't say so itself (Wayland
 * keeps pointer locks between the app and the compositor), but its cursor
 * reports show it.
 */
export class GrabDetector {
  private sent: (Point & { t: number })[] = [];
  /** Where the host says its pointer is; null when it's off the picture or hidden. */
  private host: Point | null = null;
  /** The host reports its pointer at all; without that there's nothing to go on. */
  private reported = false;
  /** Where the host pointer was at the last check. */
  private hostBefore: Point | null = null;
  /** The last check's due time. */
  private dueBefore = 0;
  private misses = 0;
  private hits = 0;
  private lastCheck = 0;
  grabbed = false;
  /** The input round trip, ms. */
  rtt = 0;
  onChange?: (grabbed: boolean) => void;

  sentMove(x: number, y: number, now: number) {
    this.sent.push({ x, y, t: now });
    while (this.sent.length > 0 && now - this.sent[0]!.t > 2000) this.sent.shift();
    if (now - this.lastCheck >= CHECK_MS) {
      this.lastCheck = now;
      this.check(now);
    }
  }

  hostAt(pos: Point | null) {
    this.host = pos;
    if (pos) this.reported = true;
  }

  reset() {
    this.sent = [];
    this.misses = 0;
    this.set(false);
  }

  /**
   * Compares the host pointer with where it was sent. Sent somewhere new
   * since the last check (allowing for the lag), a pointer that's free has
   * moved and is near one of the places sent lately; a grabbed one sits still.
   */
  check(now: number) {
    const due = now - LAG_MS - this.rtt;
    if (!this.reported || !this.sent.some((s) => s.t <= due)) return;
    const recent = this.sent.filter((s) => s.t >= due - MOVE_WINDOW_MS);
    // Where it should have been at the last check, and should be now.
    const at = (t: number) => this.sent.findLast((s) => s.t <= t);
    const was = at(this.dueBefore), is = at(due);
    this.dueBefore = due;
    const sentMoved = !!was && !!is && dist(was, is) > MOVING;
    const host = this.host;
    const off = host ? Math.min(...recent.map((s) => dist(host, s))) : Number.POSITIVE_INFINITY;
    const hostMoved = !!host && !!this.hostBefore && dist(host, this.hostBefore) > HOST_MOVED;
    this.hostBefore = host;
    if (!sentMoved) return;
    const follows = hostMoved && off < HIT;
    if (!this.grabbed) {
      if (follows) this.misses = 0;
      else if (!hostMoved && off > HIT && ++this.misses >= MISSES) this.set(true);
    } else if (follows) {
      if (++this.hits >= HITS) this.set(false);
    } else this.hits = 0;
  }

  private set(grabbed: boolean) {
    if (grabbed === this.grabbed) return;
    this.grabbed = grabbed;
    this.misses = this.hits = 0;
    this.onChange?.(grabbed);
  }
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
