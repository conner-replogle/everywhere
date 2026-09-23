import { useState } from "react";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PASSWORD_MAX, PASSWORD_MIN } from "@/lib/api";
import { errorMessage } from "@/lib/utils";

/** Narrow centered column shared by the sign-in steps and signup. */
export function AuthShell({
  title,
  description,
  onSubmit,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-full items-start justify-center px-4 pt-[16vh]">
      <form onSubmit={onSubmit} className="flex w-full max-w-[320px] flex-col gap-5">
        <Logo />
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          {description && <p className="text-muted-foreground">{description}</p>}
        </div>
        {children}
      </form>
    </div>
  );
}

export function FormAlert({ children, tone = "error" }: { children: React.ReactNode; tone?: "error" | "info" }) {
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={
        tone === "error"
          ? "rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-destructive"
          : "rounded-md border border-warn/30 bg-warn/10 px-2.5 py-2 text-warn"
      }
    >
      {children}
    </p>
  );
}

export function AuthForm({
  title,
  description,
  submitLabel,
  passwordHint,
  autoCompletePassword,
  initialUsername = "",
  notice,
  footer,
  onSubmit,
}: {
  title: string;
  description?: string;
  submitLabel: string;
  passwordHint?: string;
  autoCompletePassword: "current-password" | "new-password";
  initialUsername?: string;
  /** Informational message above the submit button (e.g. why the user is back here). */
  notice?: string | null;
  footer?: React.ReactNode;
  onSubmit: (username: string, password: string) => Promise<void>;
}) {
  const [username, setUsername] = useState(initialUsername);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isNew = autoCompletePassword === "new-password";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(username, password);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <AuthShell title={title} description={description} onSubmit={submit}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="username">Username</Label>
          <Input
            id="username"
            autoComplete="username"
            autoFocus={!initialUsername}
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoComplete={autoCompletePassword}
            autoFocus={!!initialUsername}
            required
            minLength={isNew ? PASSWORD_MIN : undefined}
            maxLength={isNew ? PASSWORD_MAX : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {passwordHint && <p className="text-xs text-muted-foreground">{passwordHint}</p>}
        </div>
      </div>
      {error ? <FormAlert>{error}</FormAlert> : notice ? <FormAlert tone="info">{notice}</FormAlert> : null}
      <Button type="submit" disabled={busy}>
        {busy ? "…" : submitLabel}
      </Button>
      {footer}
    </AuthShell>
  );
}
