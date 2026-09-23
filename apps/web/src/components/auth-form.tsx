import { useState } from "react";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/utils";

export function AuthForm({
  title,
  description,
  submitLabel,
  passwordHint,
  autoCompletePassword,
  onSubmit,
}: {
  title: string;
  description?: string;
  submitLabel: string;
  passwordHint?: string;
  autoCompletePassword: "current-password" | "new-password";
  onSubmit: (username: string, password: string) => Promise<void>;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    <div className="flex min-h-full items-start justify-center px-4 pt-[16vh]">
      <form onSubmit={submit} className="flex w-full max-w-[320px] flex-col gap-5">
        <Logo />
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          {description && <p className="text-muted-foreground">{description}</p>}
        </div>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="username">Username</Label>
            <Input
              id="username"
              autoComplete="username"
              autoFocus
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
              required
              minLength={autoCompletePassword === "new-password" ? 8 : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {passwordHint && <p className="text-xs text-muted-foreground">{passwordHint}</p>}
          </div>
        </div>
        {error && (
          <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy}>
          {busy ? "…" : submitLabel}
        </Button>
      </form>
    </div>
  );
}
