// How loud the mic and the assistant's voice are right now, for the voice
// visualizer. Whichever voice is running hands its streams here; the
// visualizer reads them every frame.

let ctx: AudioContext | null = null;
const analysers: { mic: AnalyserNode | null; out: AnalyserNode | null } = { mic: null, out: null };
const sources: { mic: AudioNode | null; out: AudioNode | null } = { mic: null, out: null };

function analyser(): AnalyserNode {
  ctx ??= new AudioContext();
  void ctx.resume();
  const a = ctx.createAnalyser();
  a.fftSize = 256;
  a.smoothingTimeConstant = 0.72;
  return a;
}

/** Listens to a stream (only measured, never played). null stops. */
export function watchStream(which: "mic" | "out", stream: MediaStream | null): void {
  sources[which]?.disconnect();
  sources[which] = null;
  analysers[which] = null;
  if (!stream?.getAudioTracks().length) return;
  const a = analyser();
  const src = ctx!.createMediaStreamSource(stream);
  src.connect(a);
  sources[which] = src;
  analysers[which] = a;
}

/** For audio played through Web Audio: an analyser in its context to route it through. */
export function outputAnalyser(context: AudioContext): AnalyserNode {
  const a = context.createAnalyser();
  a.fftSize = 256;
  a.smoothingTimeConstant = 0.72;
  analysers.out = a;
  return a;
}

export function clearOutput(a: AnalyserNode): void {
  if (analysers.out === a) analysers.out = null;
}

const buffers = new WeakMap<AnalyserNode, Uint8Array<ArrayBuffer>>();

/**
 * The speech band (about 80 Hz to 4 kHz) of one source, in n bands from 0
 * to 1, written into out; all zero when it's silent or not running.
 */
export function bands(which: "mic" | "out", out: Float32Array): void {
  const a = analysers[which];
  out.fill(0);
  if (!a) return;
  let data = buffers.get(a);
  if (!data) buffers.set(a, (data = new Uint8Array(a.frequencyBinCount)));
  a.getByteFrequencyData(data);
  const hz = a.context.sampleRate / a.fftSize;
  const lo = Math.max(1, Math.floor(80 / hz));
  const hi = Math.min(data.length, Math.ceil(4000 / hz));
  const n = out.length;
  for (let i = 0; i < n; i++) {
    const from = lo + Math.floor(((hi - lo) * i) / n);
    const to = Math.max(from + 1, lo + Math.floor(((hi - lo) * (i + 1)) / n));
    let sum = 0;
    for (let j = from; j < to; j++) sum += data[j]!;
    // A little gate, so room noise doesn't flicker.
    out[i] = Math.max(0, (sum / (to - from) / 255 - 0.12) / 0.88);
  }
}
