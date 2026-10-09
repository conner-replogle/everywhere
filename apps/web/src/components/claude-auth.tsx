import type { ClaudeAuth } from "@everywhere/protocol";
import { CheckIcon, ExternalLinkIcon, KeyRoundIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useDevice } from "@/components/device-context";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useRpc } from "@/lib/peer";
import { cn, errorMessage } from "@/lib/utils";

export interface ClaudeAuthCheck {
  data: ClaudeAuth | undefined;
  refetch: () => void;
}

/**
 * Whether the device's Claude Code is signed in: asked on connect, when the
 * daemon says it changed, and when the tab comes back into view (it may have
 * been signed in or out in a terminal on the device).
 */
export function useClaudeAuth(): ClaudeAuthCheck {
  const { peer, conn, info } = useDevice();
  const enabled = conn.state === "connected" && !!info.data?.features?.includes("claudeAuth");
  const q = useRpc(peer, "agent.auth", {}, ["claude.auth"], enabled);
  const { refetch } = q;

  useEffect(() => {
    if (!enabled) return;
    const onVisible = () => document.visibilityState === "visible" && refetch();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [enabled, refetch]);

  return { data: enabled ? q.data : undefined, refetch };
}

/** Signed out: never signed in, or claude's credentials stopped working. */
export function signedOut(auth: ClaudeAuth | undefined): boolean {
  return !!auth && !auth.signedIn;
}

type Step = { at: "choose" } | { at: "code"; url: string } | { at: "done"; auth?: ClaudeAuth };

/**
 * Signs the device's Claude Code in from here. The daemon runs
 * `claude auth login`, whose sign-in page opens in this browser and ends on a
 * code to paste back, so it works from any device.
 */
export function ClaudeSignIn({
  auth,
  open,
  onOpenChange,
}: {
  auth: ClaudeAuth | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { device, peer, info } = useDevice();
  const [step, setStep] = useState<Step>({ at: "choose" });
  const [consoleAccount, setConsoleAccount] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = device?.name ?? info.data?.hostname ?? "this device";

  useEffect(() => {
    if (open) {
      setStep({ at: "choose" });
      setConsoleAccount(auth?.method === "console");
      setCode("");
      setBusy(false);
      setError(null);
    }
  }, [open, auth?.method]);

  function close(o: boolean) {
    // A sign-in left waiting for its code would hold claude's login open.
    if (!o && step.at === "code") peer.call("agent.loginCancel", {}).catch(() => {});
    onOpenChange(o);
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const start = () =>
    run(async () => {
      const r = await peer.call("agent.login", consoleAccount ? { console: true } : {});
      setStep(r.url ? { at: "code", url: r.url } : { at: "done" });
    });

  const finish = (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    void run(async () => {
      const a = await peer.call("agent.loginCode", { code: code.trim() });
      setStep({ at: "done", auth: a });
    });
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-md">
        {step.at === "choose" && (
          <div className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Sign in to Claude Code on {name}</DialogTitle>
              <DialogDescription asChild>
                <div className="grid gap-2">
                  {auth?.problem && <p className="text-warn">Claude said: {auth.problem}</p>}
                  <p>
                    You'll sign in on Anthropic's page here, then paste back the code it shows. Claude threads on{" "}
                    {name} switch to the new sign-in when they're next idle.
                  </p>
                </div>
              </DialogDescription>
            </DialogHeader>
            <div role="radiogroup" aria-label="Account" className="grid gap-1">
              <AccountOption
                on={!consoleAccount}
                onPick={() => setConsoleAccount(false)}
                label="Claude subscription"
                hint="Pro, Max, Team or Enterprise"
              />
              <AccountOption
                on={consoleAccount}
                onPick={() => setConsoleAccount(true)}
                label="Anthropic Console"
                hint="Pay for API usage"
              />
            </div>
            {error && <p className="text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button onClick={() => void start()} disabled={busy}>
                <KeyRoundIcon />
                {busy ? "Starting…" : "Continue"}
              </Button>
            </DialogFooter>
          </div>
        )}

        {step.at === "code" && (
          <form onSubmit={finish} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Sign in to Claude Code on {name}</DialogTitle>
              <DialogDescription>Approve on Anthropic's page, then paste the code it gives you.</DialogDescription>
            </DialogHeader>
            <ol className="grid gap-3">
              <li className="grid gap-1.5">
                <span className="text-xs text-muted-foreground">1. Sign in and approve</span>
                <Button asChild variant="secondary" className="justify-self-start">
                  <a href={step.url} target="_blank" rel="noreferrer">
                    <ExternalLinkIcon />
                    Open sign-in page
                  </a>
                </Button>
              </li>
              <li className="grid gap-1.5">
                <label htmlFor="claude-login-code" className="text-xs text-muted-foreground">
                  2. Paste the code
                </label>
                <Input
                  id="claude-login-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="Authentication code"
                  autoComplete="one-time-code"
                  spellCheck={false}
                  className="font-mono"
                />
              </li>
            </ol>
            {error && <p className="text-destructive">{error}</p>}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !code.trim()}>
                {busy ? "Signing in…" : "Sign in"}
              </Button>
            </DialogFooter>
          </form>
        )}

        {step.at === "done" && (
          <div className="grid gap-4">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CheckIcon className="size-4 text-live" />
                Claude Code is signed in
              </DialogTitle>
              <DialogDescription>
                {step.auth?.email ? `${name} uses ${step.auth.email}. ` : ""}
                {auth?.problem && "Send your prompt again to pick up where you left off."}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button onClick={() => close(false)}>Done</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AccountOption({ on, onPick, label, hint }: { on: boolean; onPick: () => void; label: string; hint: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onPick}
      className={cn(
        "flex items-center gap-3 rounded-md border px-3 py-2 text-left focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none",
        on ? "border-primary/60 bg-accent" : "border-transparent hover:bg-accent/60",
      )}
    >
      <span className="grid min-w-0 flex-1">
        <span>{label}</span>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </span>
      {on && <CheckIcon className="size-4 shrink-0 text-primary" />}
    </button>
  );
}

/** Above a thread's composer while the device's claude is signed out. */
export function SignedOutBanner({ auth, onSignIn }: { auth: ClaudeAuth; onSignIn: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-warn/40 bg-card px-3 py-2 text-[13px] max-sm:flex-wrap">
      <KeyRoundIcon className="size-4 shrink-0 text-warn" />
      <div className="grid min-w-0 flex-1">
        <span className="font-medium">Claude Code isn't signed in on this device</span>
        <span className="text-xs text-muted-foreground">
          {auth.signingIn ? "A sign-in is waiting for its code." : (auth.problem ?? "Prompts fail until it is.")}
        </span>
      </div>
      <Button size="sm" variant="secondary" className="shrink-0" onClick={onSignIn}>
        <KeyRoundIcon />
        Sign in
      </Button>
    </div>
  );
}
