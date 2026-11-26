import { createFileRoute } from "@tanstack/react-router";
import { KeyRoundIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Section } from "@/components/settings-section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type AgentKeyInfo, type AgentKeyResult, api } from "@/lib/api";
import { useDevices } from "@/lib/devices";
import { cn, errorMessage } from "@/lib/utils";

export const Route = createFileRoute("/_app/_workspace/settings/antigravity")({
  component: AntigravitySettings,
});

const KIND = "antigravity";

/**
 * The account's Antigravity API key (a Gemini API key): every device's
 * daemon gives it to Antigravity instead of each signing in on its own.
 */
function AntigravitySettings() {
  const [info, setInfo] = useState<AgentKeyInfo | undefined>();
  const [result, setResult] = useState<AgentKeyResult["devices"] | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const devices = useDevices();
  const name = (id: string) => devices.devices?.find((d) => d.id === id)?.name ?? id;

  useEffect(() => {
    api.agentKeys().then(
      (all) => setInfo(all[KIND] ?? { set: false }),
      (e: unknown) => setError(errorMessage(e)),
    );
  }, []);

  const run = async (fn: () => Promise<AgentKeyResult>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      setInfo(r.set ? { set: true, hint: r.hint, setAt: r.setAt } : { set: false });
      setResult(r.devices);
      setKey("");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-base font-semibold tracking-tight">Antigravity</h1>
        <p className="text-xs text-muted-foreground">
          Google's coding agent, on devices with the Antigravity CLI (<code className="font-mono">agy</code>) installed.
        </p>
      </div>
      <Section
        title="API key for every device"
        description={
          <>
            Make a Gemini API key at{" "}
            <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" className="underline underline-offset-2">
              aistudio.google.com/apikey
            </a>{" "}
            and paste it here. Every device's Antigravity then uses it, as{" "}
            <code className="font-mono">GEMINI_API_KEY</code>, instead of the Google sign-in it has there. Its use is billed
            to the key's Google Cloud project (or its free tier), not to a Google AI subscription.
          </>
        }
      >
        <div className="grid gap-3">
          <p className="text-muted-foreground">
            {!info
              ? "Checking…"
              : info.set
                ? `Set ${new Date(info.setAt).toLocaleString()}, ending …${info.hint}. Devices get it whenever they connect.`
                : "Not set: each device uses Antigravity's own sign-in (run agy once there to sign in)."}
          </p>
          <form
            className="flex gap-2 max-sm:flex-wrap"
            onSubmit={(e) => {
              e.preventDefault();
              if (key.trim()) void run(() => api.setAgentKey(KIND, key.trim()));
            }}
          >
            <Input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={info?.set ? "Paste a new key to replace it" : "AIza…"}
              autoComplete="off"
              spellCheck={false}
              aria-label="Antigravity API key"
              className="min-w-0 flex-1 font-mono"
            />
            <Button type="submit" size="sm" disabled={busy || !key.trim()}>
              <KeyRoundIcon />
              {info?.set ? "Replace" : "Save"}
            </Button>
            {info?.set && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void run(() => api.removeAgentKey(KIND))}
              >
                Remove
              </Button>
            )}
          </form>
          {result && (
            <ul className="grid gap-0.5 text-xs">
              {Object.keys(result).length === 0 && (
                <li className="text-muted-foreground">No device is connected; each gets it when it connects.</li>
              )}
              {Object.entries(result).map(([id, r]) => (
                <li key={id} className={cn(r === "ok" ? "text-muted-foreground" : "text-warn")}>
                  {name(id)}: {r === "ok" ? "updated" : r}
                </li>
              ))}
            </ul>
          )}
          {error && <p className="text-destructive">{error}</p>}
        </div>
      </Section>
    </div>
  );
}
