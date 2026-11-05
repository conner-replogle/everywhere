import { createFileRoute } from "@tanstack/react-router";
import { KeyRoundIcon, MicIcon, SquareIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { VoiceBars } from "@/components/assistant/visualizer";
import { Section } from "@/components/settings-section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, type OpenAIKeyInfo } from "@/lib/api";
import { watchStream } from "@/lib/assistant/levels";
import { micDeviceId, micInputs, openMic, setMicDeviceId } from "@/lib/assistant/mic";
import { useVoice } from "@/lib/assistant/voice";
import { setVoiceEngine, type VoiceEngine, voiceEngine } from "@/lib/assistant/voice-engine";
import { errorMessage } from "@/lib/utils";

export const Route = createFileRoute("/_app/_workspace/settings/assistant")({
  component: AssistantSettings,
});

function AssistantSettings() {
  const [info, setInfo] = useState<OpenAIKeyInfo | undefined>();
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-base font-semibold tracking-tight">Assistant</h1>
        <p className="text-xs text-muted-foreground">The conversation about all your devices, and its voice.</p>
      </div>
      <OpenAIKey info={info} onInfo={setInfo} />
      <Voice live={info?.set ?? false} />
      <Microphone />
    </div>
  );
}

/** The account's OpenAI API key, which GPT-Live (the voice) runs on. */
function OpenAIKey({ info, onInfo }: { info: OpenAIKeyInfo | undefined; onInfo: (i: OpenAIKeyInfo) => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.openaiKey().then(onInfo, (e: unknown) => setError(errorMessage(e)));
  }, [onInfo]);

  const run = async (fn: () => Promise<OpenAIKeyInfo>) => {
    setBusy(true);
    setError(null);
    try {
      onInfo(await fn());
      setKey("");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="OpenAI API key"
      description={
        <>
          GPT-Live, OpenAI's voice model, listens and talks for the assistant; the assistant itself still runs on Workers AI.
          The key is kept sealed with your account, used only by your Worker to start voice sessions, and never sent to a
          browser. Voice costs about $0.05 a minute on your OpenAI account.
        </>
      }
    >
      <div className="grid gap-3">
        <p className="text-muted-foreground">
          {!info
            ? "Checking…"
            : info.set
              ? `Set ${new Date(info.setAt).toLocaleString()}, ending …${info.hint}.`
              : "Not set: the assistant's voice uses Workers AI (Deepgram) instead."}
        </p>
        <form
          className="flex gap-2 max-sm:flex-wrap"
          onSubmit={(e) => {
            e.preventDefault();
            if (key.trim()) void run(() => api.setOpenAIKey(key.trim()));
          }}
        >
          <Input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder={info?.set ? "Paste a new key to replace it" : "sk-…"}
            autoComplete="off"
            spellCheck={false}
            aria-label="OpenAI API key"
            className="min-w-0 flex-1 font-mono"
          />
          <Button type="submit" size="sm" disabled={busy || !key.trim()}>
            <KeyRoundIcon />
            {info?.set ? "Replace" : "Save"}
          </Button>
          {info?.set && (
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void run(() => api.removeOpenAIKey())}>
              Remove
            </Button>
          )}
        </form>
        {error && <p className="text-destructive">{error}</p>}
      </div>
    </Section>
  );
}

const ENGINES: { value: VoiceEngine; label: string; description: string }[] = [
  {
    value: "live",
    label: "GPT-Live",
    description: "Talks and listens at once, so you can interrupt it like a person. Needs the OpenAI key above.",
  },
  {
    value: "flux",
    label: "Workers AI",
    description: "Deepgram Flux to listen and Aura to speak, on your Cloudflare account. Takes turns; a little slower.",
  },
];

/** Which voice this browser uses. */
function Voice({ live }: { live: boolean }) {
  const [engine, setEngine] = useState(voiceEngine);
  return (
    <Section title="Voice" description="In this browser.">
      <div className="grid gap-2">
        {ENGINES.map((e) => (
          <label key={e.value} className="flex items-start gap-2">
            <input
              type="radio"
              name="voice-engine"
              className="mt-1"
              checked={engine === e.value}
              onChange={() => {
                setVoiceEngine(e.value);
                setEngine(e.value);
              }}
            />
            <span>
              <span className="font-medium">{e.label}</span>
              <span className="block text-xs text-muted-foreground">
                {e.description}
                {e.value === "live" && !live ? " (no key yet, so Workers AI is used)" : ""}
              </span>
            </span>
          </label>
        ))}
      </div>
    </Section>
  );
}

/** Which mic the assistant listens to here, and a test of it. */
function Microphone() {
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [chosen, setChosen] = useState(micDeviceId);
  const [testing, setTesting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const voiceOn = useVoice().state !== "off";

  const refresh = useCallback(() => {
    micInputs().then(setInputs, (e: unknown) => setError(errorMessage(e)));
  }, []);

  const stop = useCallback(() => {
    if (!stream.current) return;
    watchStream("mic", null);
    for (const t of stream.current.getTracks()) t.stop();
    stream.current = null;
    setTesting(null);
  }, []);

  const start = async () => {
    setError(null);
    try {
      const s = await openMic();
      stream.current = s;
      watchStream("mic", s);
      setTesting(s.getAudioTracks()[0]?.label || "the default microphone");
      // Names only show once the page may use the mic.
      refresh();
    } catch (e) {
      setError(e instanceof DOMException && e.name === "NotAllowedError" ? "Microphone access was denied." : errorMessage(e));
    }
  };

  useEffect(() => {
    refresh();
    navigator.mediaDevices.addEventListener("devicechange", refresh);
    return () => {
      navigator.mediaDevices.removeEventListener("devicechange", refresh);
      stop();
    };
  }, [refresh, stop]);

  const unnamed = inputs.some((d) => !d.label);
  return (
    <Section title="Microphone" description="In this browser. The desktop app has no picker of its own, and the system's default input isn't always the right one.">
      <div className="grid gap-3">
        <div className="flex gap-2 max-sm:flex-wrap">
          <select
            value={chosen}
            onChange={(e) => {
              setMicDeviceId(e.target.value);
              setChosen(e.target.value);
              // Test the one just picked.
              if (stream.current) {
                stop();
                void start();
              }
            }}
            aria-label="Microphone"
            className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-sm"
          >
            <option value="">System default</option>
            {inputs
              .filter((d) => d.deviceId && d.deviceId !== "default")
              .map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Microphone ${i + 1}`}
                </option>
              ))}
          </select>
          <Button
            type="button"
            size="sm"
            variant={testing ? "outline" : "default"}
            disabled={voiceOn}
            onClick={() => (testing ? stop() : void start())}
            title={voiceOn ? "Stop talking to the assistant to test" : undefined}
          >
            {testing ? <SquareIcon /> : <MicIcon />}
            {testing ? "Stop" : "Test"}
          </Button>
        </div>
        {testing ? (
          <div className="flex items-center gap-3">
            <VoiceBars active className="h-6 w-24 shrink-0" />
            <p className="min-w-0 truncate text-xs text-muted-foreground">Listening to {testing}. Say something: the bars should move.</p>
          </div>
        ) : (
          unnamed && <p className="text-xs text-muted-foreground">Press Test once to see the microphones' names.</p>
        )}
        {error && <p className="text-destructive">{error}</p>}
      </div>
    </Section>
  );
}
