import { createFileRoute } from "@tanstack/react-router";
import { CheckIcon, KeyRoundIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Section } from "@/components/settings-section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, type ClaudeTokenInfo, type ClaudeTokenResult } from "@/lib/api";
import { useDevices } from "@/lib/devices";
import { PERMISSION_MODES } from "@/lib/permission-modes";
import { setPref, usePrefs } from "@/lib/prefs";
import { cn, errorMessage } from "@/lib/utils";

export const Route = createFileRoute("/_app/_workspace/settings/claude")({
  component: ClaudeSettings,
});

function ClaudeSettings() {
  const prefs = usePrefs();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-base font-semibold tracking-tight">Claude</h1>
        <p className="text-xs text-muted-foreground">Defaults for new Claude threads, on every device and browser.</p>
      </div>
      <Section
        title="Default permission mode"
        description="What a new thread or Claude tab starts in. Change it for one thread from its composer."
      >
        <div role="radiogroup" aria-label="Default permission mode" className="grid gap-1">
          {PERMISSION_MODES.map((m) => {
            const on = prefs.defaultPermissionMode === m.value;
            return (
              <button
                key={m.value}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => {
                  setError(null);
                  setPref("defaultPermissionMode", m.value).catch((e: unknown) => setError(errorMessage(e)));
                }}
                className={cn(
                  "flex items-center gap-3 rounded-md border px-3 py-2 text-left focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none",
                  on ? "border-primary/60 bg-accent" : "border-transparent hover:bg-accent/60",
                )}
              >
                <span className="grid min-w-0 flex-1">
                  <span className={cn(m.value === "bypassPermissions" && "text-destructive")}>{m.label}</span>
                  <span className="text-xs text-muted-foreground">{m.hint}</span>
                </span>
                {on && <CheckIcon className="size-4 shrink-0 text-primary" />}
              </button>
            );
          })}
        </div>
        {error && <p className="mt-2 text-destructive">{error}</p>}
      </Section>
      <Section
        title="Automatic recaps"
        description="Coming back to a thread that's been idle 5+ minutes asks Claude for a one-line recap of where it stands, like Claude Code does in the terminal. Each recap is a short turn and costs a little."
        aside={
          <Button
            size="sm"
            variant={prefs.autoRecap ? "outline" : "default"}
            onClick={() => {
              setError(null);
              setPref("autoRecap", !prefs.autoRecap).catch((e: unknown) => setError(errorMessage(e)));
            }}
          >
            {prefs.autoRecap ? "Turn off" : "Turn on"}
          </Button>
        }
      >
        <p className="text-muted-foreground">
          {prefs.autoRecap
            ? "On. Type /recap in a thread to ask for one any time."
            : "Off. Type /recap in a thread to ask for one."}
        </p>
      </Section>
      <ClaudeToken />
    </div>
  );
}

/**
 * The account's Claude token: made once with `claude setup-token`, then
 * every device's daemon gives it to Claude instead of each signing in and
 * renewing on its own (which, with several threads at once, can get the
 * sign-in revoked).
 */
function ClaudeToken() {
  const [info, setInfo] = useState<ClaudeTokenInfo | undefined>();
  const [result, setResult] = useState<ClaudeTokenResult["devices"] | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const devices = useDevices();
  const name = (id: string) => devices.devices?.find((d) => d.id === id)?.name ?? id;

  useEffect(() => {
    api.claudeToken().then(setInfo, (e: unknown) => setError(errorMessage(e)));
  }, []);

  const run = async (fn: () => Promise<ClaudeTokenResult>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      setInfo(r.set ? { set: true, hint: r.hint, setAt: r.setAt } : { set: false });
      setResult(r.devices);
      setToken("");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Claude token for every device"
      description={
        <>
          Run <code className="font-mono">claude setup-token</code> on any computer, sign in with your Claude subscription,
          and paste the token it prints (it lasts a year). Every device's Claude then uses it, as{" "}
          <code className="font-mono">CLAUDE_CODE_OAUTH_TOKEN</code>, instead of signing in and renewing on its own, so
          threads running at once can't sign each other out. Devices need everywhere 0.22.8 or later.
        </>
      }
    >
      <div className="grid gap-3">
        <p className="text-muted-foreground">
          {!info
            ? "Checking…"
            : info.set
              ? `Set ${new Date(info.setAt).toLocaleString()}, ending …${info.hint}. Devices get it whenever they connect.`
              : "Not set: each device uses its own sign-in."}
        </p>
        <form
          className="flex gap-2 max-sm:flex-wrap"
          onSubmit={(e) => {
            e.preventDefault();
            if (token.trim()) void run(() => api.setClaudeToken(token.trim()));
          }}
        >
          <Input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={info?.set ? "Paste a new token to replace it" : "sk-ant-oat01-…"}
            autoComplete="off"
            spellCheck={false}
            aria-label="Claude token"
            className="min-w-0 flex-1 font-mono"
          />
          <Button type="submit" size="sm" disabled={busy || !token.trim()}>
            <KeyRoundIcon />
            {info?.set ? "Replace" : "Save"}
          </Button>
          {info?.set && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void run(() => api.removeClaudeToken())}
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
  );
}
