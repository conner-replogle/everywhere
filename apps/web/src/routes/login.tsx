import { createFileRoute, redirect, useNavigate, useRouter } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { useRef, useState } from "react";
import { AuthForm, AuthShell, FormAlert } from "@/components/auth-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "@/lib/api";
import { auth } from "@/lib/auth";
import { normalizeCode } from "@/lib/totp";
import { errorMessage } from "@/lib/utils";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
    typeof search.redirect === "string" ? { redirect: search.redirect } : {},
  beforeLoad: async () => {
    const me = await auth.load();
    if (me.user) throw redirect({ to: "/" });
    if (me.signupOpen) throw redirect({ to: "/signup" });
  },
  component: Login,
});

/** The Worker drops a challenge after this long (or after 5 wrong codes). */
const CHALLENGE_TTL_MS = 5 * 60_000;

interface Challenge {
  id: string;
  username: string;
  startedAt: number;
}

function Login() {
  const navigate = useNavigate();
  const router = useRouter();
  const { redirect: to } = Route.useSearch();
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [username, setUsername] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  async function done() {
    // Only follow same-origin paths back. The OAuth consent page is served
    // by the Worker, not the app, so it needs a real page load.
    if (to?.startsWith("/oauth/")) window.location.replace(to);
    else if (to?.startsWith("/") && !to.startsWith("//")) router.history.replace(to);
    else await navigate({ to: "/", replace: true });
  }

  if (challenge) {
    return (
      <MfaStep
        challenge={challenge}
        onDone={done}
        onRestart={(why) => {
          setUsername(challenge.username);
          setNotice(why);
          setChallenge(null);
        }}
      />
    );
  }

  return (
    <AuthForm
      key={username}
      title="Sign in"
      submitLabel="Sign in"
      autoCompletePassword="current-password"
      initialUsername={username}
      notice={notice}
      footer={<ForgotPassword />}
      onSubmit={async (u, p) => {
        const mfa = await auth.login(u, p);
        if (mfa) {
          setNotice(null);
          setChallenge({ id: mfa.challenge, username: u, startedAt: Date.now() });
          return;
        }
        await done();
      }}
    />
  );
}

function MfaStep({
  challenge,
  onDone,
  onRestart,
}: {
  challenge: Challenge;
  onDone: () => Promise<void>;
  onRestart: (why: string | null) => void;
}) {
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function submit(value: string) {
    const normalized = normalizeCode(value);
    if (!normalized || busy) return;
    if (Date.now() - challenge.startedAt > CHALLENGE_TTL_MS) {
      onRestart("That sign-in took too long. Enter your password again.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await auth.loginMfa(challenge.id, normalized);
      await onDone();
    } catch (e) {
      const msg = errorMessage(e);
      // An expired or exhausted challenge can't be retried; wrong codes can.
      const dead = e instanceof ApiError && e.status === 401 && (e.body.expired === true || /expired/i.test(msg));
      if (dead) {
        onRestart(msg);
        return;
      }
      setError(msg);
      setCode("");
      setBusy(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  return (
    <AuthShell
      title="Two-factor code"
      description={
        recovery
          ? "Enter one of the recovery codes you saved when you turned on two-factor authentication. Each works once."
          : "Enter the 6-digit code from your authenticator app."
      }
      onSubmit={(e) => {
        e.preventDefault();
        void submit(code);
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="mfa-code">{recovery ? "Recovery code" : "Authentication code"}</Label>
        <Input
          ref={inputRef}
          id="mfa-code"
          name="code"
          autoComplete="one-time-code"
          // Numeric keypad for TOTP; recovery codes have letters and a dash.
          inputMode={recovery ? "text" : "numeric"}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          autoFocus
          required
          maxLength={32}
          placeholder={recovery ? "xxxxx-xxxxx" : "123456"}
          className="font-mono tracking-wider"
          value={code}
          disabled={busy}
          onChange={(e) => {
            const v = e.target.value;
            setCode(v);
            if (/^\d{6}$/.test(v.replace(/\s/g, ""))) void submit(v);
          }}
        />
        <button
          type="button"
          className="self-start text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          onClick={() => {
            setRecovery((r) => !r);
            setCode("");
            setError(null);
            requestAnimationFrame(() => inputRef.current?.focus());
          }}
        >
          {recovery ? "Use your authenticator app instead" : "Lost your phone? Use a recovery code"}
        </button>
      </div>
      {error && <FormAlert>{error}</FormAlert>}
      <div className="flex gap-2">
        <Button type="button" variant="ghost" onClick={() => onRestart(null)}>
          <ArrowLeftIcon />
          Back
        </Button>
        <Button type="submit" className="flex-1" disabled={busy || !normalizeCode(code)}>
          {busy ? "…" : "Verify"}
        </Button>
      </div>
    </AuthShell>
  );
}

function ForgotPassword() {
  const [open, setOpen] = useState(false);
  const cmd = "rounded bg-terminal px-1 py-0.5 font-mono text-[11px] whitespace-nowrap text-foreground";
  return (
    <div className="-mt-2 flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        className="self-center text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        onClick={() => setOpen((o) => !o)}
      >
        Forgot password?
      </button>
      {open && (
        <p className="rounded-md border bg-card px-2.5 py-2 text-xs leading-relaxed text-muted-foreground">
          There's no email reset. From a machine with access to the Cloudflare account, run{" "}
          <code className={cmd}>bun run reset-password &lt;username&gt;</code> in the everywhere repo — it prints a
          temporary password. Add <code className={cmd}>--disable-2fa</code> if you also lost your authenticator and
          recovery codes.
        </p>
      )}
    </div>
  );
}
