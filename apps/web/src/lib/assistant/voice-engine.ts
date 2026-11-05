// Which voice the assistant uses in this browser: GPT-Live (OpenAI, when the
// account has a key) or Workers AI's Flux and Aura.

export type VoiceEngine = "live" | "flux";

const KEY = "ew.assistant.voice";

export function voiceEngine(): VoiceEngine {
  return localStorage.getItem(KEY) === "flux" ? "flux" : "live";
}

export function setVoiceEngine(engine: VoiceEngine): void {
  localStorage.setItem(KEY, engine);
}
