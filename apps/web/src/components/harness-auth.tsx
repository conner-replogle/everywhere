import type { HarnessAuth } from "@everywhere/protocol";
import { CheckIcon, ExternalLinkIcon, KeyRoundIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { DeviceContextValue } from "@/components/device-context";
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
import { errorMessage } from "@/lib/utils";

// Signing in agents other than Claude (Antigravity, with Google) on a
// device, from wherever the user is: as Claude's sign-in (claude-auth.tsx),
// the device runs the agent's sign-in, whose page opens here and ends on a
// code to paste back.

export interface HarnessAuthCheck {
  data: HarnessAuth | undefined;
  refetch: () => void;
}

/**
 * Whether an agent is signed in on a device: asked on connect, when the
 * daemon says sign-ins changed, and when the tab comes back into view (it
 * may have been signed in in a terminal on the device).
 */
export function useHarnessAuth(entry: DeviceContextValue, kind: string, enabled = true): HarnessAuthCheck {
  const on = enabled && entry.conn.state === "connected" && !!entry.info.data?.features?.includes("harnessAuth");
  const q = useRpc(entry.peer, "agent.harnessAuth", { kind }, ["claude.auth"], on);
  const { refetch } = q;

  useEffect(() => {
    if (!on) return;
    const onVisible = () => document.visibilityState === "visible" && refetch();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [on, refetch]);

  return { data: on ? q.data : undefined, refetch };
}

/** Installed, able to say, and not signed in. */
export function harnessSignedOut(auth: HarnessAuth | undefined): boolean {
  return !!auth && auth.installed && auth.known && !auth.signedIn;
}

/** Whose sign-in an agent's is, for its words. */
const PROVIDERS: Record<string, string> = { antigravity: "Google" };

export function signInWith(kind: string): string {
  return PROVIDERS[kind] ?? "its account";
}

type Step = { at: "start" } | { at: "code"; url: string } | { at: "done"; auth?: HarnessAuth };

/** Starting a sign-in and checking its code run the agent on the device: the daemon gives each a minute. */
const SIGN_IN_TIMEOUT_MS = 90_000;

/** Signs an agent in on a device from here. */
export function HarnessSignIn({
  entry,
  kind,
  title,
  open,
  onOpenChange,
  onDone,
}: {
  entry: DeviceContextValue;
  kind: string;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone?: () => void;
}) {
  const { peer, device, info } = entry;
  const [step, setStep] = useState<Step>({ at: "start" });
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = device?.name ?? info.data?.hostname ?? "this device";
  const provider = signInWith(kind);

  useEffect(() => {
    if (open) {
      setStep({ at: "start" });
      setCode("");
      setBusy(false);
      setError(null);
    }
  }, [open]);

  function close(o: boolean) {
    // A sign-in left waiting for its code would hold the agent's login open.
    if (!o && step.at === "code") peer.call("agent.harnessLoginCancel", { kind }).catch(() => {});
    if (!o && step.at === "done") onDone?.();
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
      const r = await peer.call("agent.harnessLogin", { kind }, SIGN_IN_TIMEOUT_MS);
      setStep(r.url ? { at: "code", url: r.url } : { at: "done" });
    });

  const finish = (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    void run(async () => {
      try {
        const a = await peer.call("agent.harnessLoginCode", { kind, code: code.trim() }, SIGN_IN_TIMEOUT_MS);
        setStep({ at: "done", auth: a });
      } catch (e) {
        // The sign-in ends with a refused code: Continue starts another.
        setStep({ at: "start" });
        setCode("");
        throw e;
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-md">
        {step.at === "start" && (
          <div className="grid gap-4">
            <DialogHeader>
              <DialogTitle>
                Sign in to {title} on {name}
              </DialogTitle>
              <DialogDescription>
                You'll sign in with {provider} on its page here, then paste back the code it shows. {title} on {name}{" "}
                then uses your {provider} account, and its plan.
              </DialogDescription>
            </DialogHeader>
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
              <DialogTitle>
                Sign in to {title} on {name}
              </DialogTitle>
              <DialogDescription>
                Sign in on {provider}'s page, then paste the code you land on (or the page's whole address).
              </DialogDescription>
            </DialogHeader>
            <ol className="grid gap-3">
              <li className="grid gap-1.5">
                <span className="text-xs text-muted-foreground">1. Sign in with {provider}</span>
                <Button asChild variant="secondary" className="justify-self-start">
                  <a href={step.url} target="_blank" rel="noreferrer">
                    <ExternalLinkIcon />
                    Open sign-in page
                  </a>
                </Button>
              </li>
              <li className="grid gap-1.5">
                <label htmlFor="harness-login-code" className="text-xs text-muted-foreground">
                  2. Paste the code
                </label>
                <Input
                  id="harness-login-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="Authorization code"
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
                {title} is signed in
              </DialogTitle>
              <DialogDescription>
                {name} uses your {provider} account for {title} now.
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

/** Above a thread's composer while its agent is signed out on the device. */
export function HarnessSignedOutBanner({ auth, onSignIn }: { auth: HarnessAuth; onSignIn?: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-warn/40 bg-card px-3 py-2 text-[13px] max-sm:flex-wrap">
      <KeyRoundIcon className="size-4 shrink-0 text-warn" />
      <div className="grid min-w-0 flex-1">
        <span className="font-medium">{auth.title} isn't signed in on this device</span>
        <span className="text-xs text-muted-foreground">
          {auth.signingIn ? "A sign-in is waiting for its code." : "Prompts fail until it is."}
        </span>
      </div>
      {auth.canSignIn && onSignIn && (
        <Button size="sm" variant="secondary" className="shrink-0" onClick={onSignIn}>
          <KeyRoundIcon />
          Sign in with {signInWith(auth.kind)}
        </Button>
      )}
    </div>
  );
}
