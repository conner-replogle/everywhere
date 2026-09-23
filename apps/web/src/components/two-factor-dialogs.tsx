import { DownloadIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { QrCode } from "@/components/qr-code";
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
import { Label } from "@/components/ui/label";
import { api, type TotpSetup } from "@/lib/api";
import { auth, useAuth } from "@/lib/auth";
import { groupSecret, looksLikeCode, normalizeCode } from "@/lib/totp";
import { errorMessage } from "@/lib/utils";

type OpenProps = { open: boolean; onOpenChange: (o: boolean) => void };

/** Shared busy/error handling for a dialog's async steps. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reset = () => {
    setBusy(false);
    setError(null);
  };
  async function run(fn: () => Promise<void>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setBusy(false);
      return true;
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
      return false;
    }
  }
  return { busy, error, run, reset };
}

function ErrorText({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="text-destructive">
      {children}
    </p>
  );
}

/**
 * A code field. `totpOnly` gets a numeric keypad and fires `onComplete` as
 * soon as six digits are in; otherwise recovery codes (letters, dash) are fine too.
 */
function CodeField({
  id,
  label,
  value,
  onChange,
  onComplete,
  totpOnly = false,
  autoFocus = false,
  disabled = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  onComplete?: (v: string) => void;
  totpOnly?: boolean;
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        autoComplete="one-time-code"
        inputMode={totpOnly ? "numeric" : "text"}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        autoFocus={autoFocus}
        disabled={disabled}
        required
        maxLength={32}
        placeholder={totpOnly ? "123456" : "123456 or xxxxx-xxxxx"}
        className="font-mono tracking-wider"
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v);
          if (onComplete && /^\d{6}$/.test(normalizeCode(v))) onComplete(v);
        }}
      />
    </div>
  );
}

function PasswordField({
  id,
  value,
  onChange,
  autoFocus = false,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>Current password</Label>
      <Input
        id={id}
        type="password"
        autoComplete="current-password"
        autoFocus={autoFocus}
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

// --- recovery codes ------------------------------------------------------------

function recoveryCodesText(codes: string[], username: string | undefined): string {
  return [
    `everywhere recovery codes${username ? ` for ${username}` : ""} (${location.host})`,
    `Generated ${new Date().toLocaleString()}`,
    "Each code can be used once instead of an authenticator code.",
    "",
    ...codes,
    "",
  ].join("\n");
}

function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Shown once, right after the codes are generated. Must be acknowledged to close. */
function RecoveryCodes({
  codes,
  saved,
  onSavedChange,
}: {
  codes: string[];
  saved: boolean;
  onSavedChange: (v: boolean) => void;
}) {
  const me = useAuth();
  const text = recoveryCodesText(codes, me?.user?.username);
  return (
    <div className="flex flex-col gap-3">
      <ol className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-md border bg-terminal px-4 py-3 font-mono text-[13px]">
        {codes.map((c, i) => (
          <li key={c} className="flex gap-2">
            <span className="w-4 text-right text-muted-foreground/60 select-none tabular-nums">{i + 1}</span>
            <span className="select-all">{c}</span>
          </li>
        ))}
      </ol>
      <div className="flex gap-2">
        <CopyButton text={codes.join("\n")} label="Copy all" />
        <Button type="button" variant="secondary" size="sm" onClick={() => download("everywhere-recovery-codes.txt", text)}>
          <DownloadIcon />
          Download .txt
        </Button>
      </div>
      <p className="flex items-start gap-2 text-xs text-warn">
        <TriangleAlertIcon className="mt-px size-3.5 shrink-0" />
        These won't be shown again. Store them somewhere other than this device, like a password manager.
      </p>
      <label className="flex items-center gap-2 select-none">
        <input
          type="checkbox"
          className="size-3.5 accent-primary"
          checked={saved}
          onChange={(e) => onSavedChange(e.target.checked)}
        />
        I saved these recovery codes
      </label>
    </div>
  );
}

// --- set up --------------------------------------------------------------------

type SetupStep = { kind: "password" } | { kind: "scan"; setup: TotpSetup } | { kind: "codes"; codes: string[] };

export function SetupTwoFactorDialog({ open, onOpenChange }: OpenProps) {
  const [step, setStep] = useState<SetupStep>({ kind: "password" });
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [saved, setSaved] = useState(false);
  const action = useAction();
  const codeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setStep({ kind: "password" });
    setPassword("");
    setCode("");
    setSaved(false);
    action.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const locked = step.kind === "codes" && !saved;

  async function start(e: React.FormEvent) {
    e.preventDefault();
    await action.run(async () => {
      const setup = await api.totpSetup(password);
      setPassword("");
      setStep({ kind: "scan", setup });
    });
  }

  async function enable(value: string) {
    if (action.busy) return;
    const ok = await action.run(async () => {
      const { recoveryCodes } = await api.totpEnable(normalizeCode(value));
      setStep({ kind: "codes", codes: recoveryCodes });
      void auth.refresh();
    });
    if (!ok) {
      setCode("");
      requestAnimationFrame(() => codeRef.current?.querySelector("input")?.focus());
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o || !locked) && onOpenChange(o)}>
      <DialogContent className="max-w-md outline-none" showCloseButton={!locked}>
        {step.kind === "password" && (
          <form onSubmit={start} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Set up two-factor authentication</DialogTitle>
              <DialogDescription>
                After this, signing in needs your password and a code from an authenticator app (1Password, Google
                Authenticator, Aegis, …). Confirm your password to begin.
              </DialogDescription>
            </DialogHeader>
            <PasswordField id="totp-setup-password" value={password} onChange={setPassword} autoFocus />
            {action.error && <ErrorText>{action.error}</ErrorText>}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={action.busy || !password}>
                Continue
              </Button>
            </DialogFooter>
          </form>
        )}

        {step.kind === "scan" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void enable(code);
            }}
            className="grid gap-4"
          >
            <DialogHeader>
              <DialogTitle>Scan with your authenticator app</DialogTitle>
              <DialogDescription>Then enter the 6-digit code it shows to finish.</DialogDescription>
            </DialogHeader>
            <div className="flex items-start gap-4 max-sm:flex-col max-sm:items-center">
              <QrCode value={step.setup.otpauthUri} size={168} />
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <span className="text-xs text-muted-foreground">Can't scan? Enter this key manually:</span>
                <code className="rounded-md border bg-terminal px-2.5 py-2 font-mono text-[13px] leading-relaxed break-words text-foreground select-all">
                  {groupSecret(step.setup.secret)}
                </code>
                <div>
                  <CopyButton text={step.setup.secret} label="Copy key" />
                </div>
                <span className="text-xs text-muted-foreground">Time-based, 6 digits, 30 seconds.</span>
              </div>
            </div>
            <div ref={codeRef}>
              <CodeField
                id="totp-setup-code"
                label="Code from the app"
                totpOnly
                autoFocus
                value={code}
                onChange={setCode}
                onComplete={(v) => void enable(v)}
                disabled={action.busy}
              />
            </div>
            {action.error && <ErrorText>{action.error}</ErrorText>}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={action.busy || !/^\d{6}$/.test(normalizeCode(code))}>
                Turn on
              </Button>
            </DialogFooter>
          </form>
        )}

        {step.kind === "codes" && (
          <>
            <DialogHeader>
              <DialogTitle>Two-factor authentication is on</DialogTitle>
              <DialogDescription>
                Save these recovery codes. If you lose your authenticator, each one lets you sign in once.
              </DialogDescription>
            </DialogHeader>
            <RecoveryCodes codes={step.codes} saved={saved} onSavedChange={setSaved} />
            <DialogFooter>
              <Button disabled={!saved} onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// --- regenerate recovery codes -------------------------------------------------------

export function RegenerateCodesDialog({ open, onOpenChange }: OpenProps) {
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState("");
  const [saved, setSaved] = useState(false);
  const action = useAction();

  useEffect(() => {
    if (!open) return;
    setCodes(null);
    setCode("");
    setSaved(false);
    action.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const locked = codes !== null && !saved;

  async function regenerate(value: string) {
    if (action.busy) return;
    const ok = await action.run(async () => {
      const { recoveryCodes } = await api.regenerateRecoveryCodes(normalizeCode(value));
      setCodes(recoveryCodes);
      void auth.refresh();
    });
    if (!ok) setCode("");
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o || !locked) && onOpenChange(o)}>
      <DialogContent className="max-w-md outline-none" showCloseButton={!locked}>
        {codes === null ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void regenerate(code);
            }}
            className="grid gap-4"
          >
            <DialogHeader>
              <DialogTitle>Regenerate recovery codes</DialogTitle>
              <DialogDescription>
                You'll get 10 new codes. Your current recovery codes stop working immediately.
              </DialogDescription>
            </DialogHeader>
            <CodeField
              id="regen-code"
              label="Code from your authenticator app"
              totpOnly
              autoFocus
              value={code}
              onChange={setCode}
              onComplete={(v) => void regenerate(v)}
              disabled={action.busy}
            />
            {action.error && <ErrorText>{action.error}</ErrorText>}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={action.busy || !/^\d{6}$/.test(normalizeCode(code))}>
                Regenerate
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>New recovery codes</DialogTitle>
              <DialogDescription>Your old codes no longer work. Save these instead.</DialogDescription>
            </DialogHeader>
            <RecoveryCodes codes={codes} saved={saved} onSavedChange={setSaved} />
            <DialogFooter>
              <Button disabled={!saved} onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// --- disable -------------------------------------------------------------------------

export function DisableTwoFactorDialog({ open, onOpenChange }: OpenProps) {
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const action = useAction();

  useEffect(() => {
    if (!open) return;
    setPassword("");
    setCode("");
    action.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const ok = await action.run(async () => {
      await api.totpDisable(password, normalizeCode(code));
      await auth.refresh();
    });
    if (ok) onOpenChange(false);
    else setCode("");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Turn off two-factor authentication?</DialogTitle>
            <DialogDescription>
              Anyone with your password could then sign in and open a shell on every device you've enrolled. Your
              recovery codes are deleted.
            </DialogDescription>
          </DialogHeader>
          <PasswordField id="totp-disable-password" value={password} onChange={setPassword} autoFocus />
          <CodeField id="totp-disable-code" label="Authenticator or recovery code" value={code} onChange={setCode} />
          {action.error && <ErrorText>{action.error}</ErrorText>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={action.busy || !password || !looksLikeCode(code)}>
              Turn off
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
