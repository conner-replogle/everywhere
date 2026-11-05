// The assistant's microphone: turns the mic's audio (at the context's own
// rate) into 16 kHz mono 16-bit PCM, posted to the page every 100 ms. Served
// as a file because the page's CSP doesn't run scripts from blob: URLs.

const OUT_RATE = 16000;
const CHUNK = OUT_RATE / 10;

class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / OUT_RATE;
    this.pos = 0;
    this.prev = 0;
    this.out = new Int16Array(CHUNK);
    this.n = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    // Linear interpolation from the input rate down to 16 kHz.
    while (this.pos < input.length) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      const a = i === 0 ? this.prev : input[i - 1];
      const b = input[i];
      const s = Math.max(-1, Math.min(1, a + (b - a) * frac));
      this.out[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.n === CHUNK) {
        this.port.postMessage(this.out.buffer, [this.out.buffer]);
        this.out = new Int16Array(CHUNK);
        this.n = 0;
      }
      this.pos += this.step;
    }
    this.pos -= input.length;
    this.prev = input[input.length - 1];
    return true;
  }
}

registerProcessor("pcm", PcmProcessor);
