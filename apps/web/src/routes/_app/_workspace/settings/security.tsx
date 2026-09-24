import { createFileRoute } from "@tanstack/react-router";
import {
  BotIcon,
  CheckIcon,
  LogOutIcon,
  MonitorIcon,
  ShieldCheckIcon,
  ShieldOffIcon,
  SmartphoneIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyButton } from "@/components/copy-button";
import {
  DisableTwoFactorDialog,
  RegenerateCodesDialog,
  SetupTwoFactorDialog,
} from "@/components/two-factor-dialogs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type Connection, PASSWORD_HINT, PASSWORD_MAX, PASSWORD_MIN, type Session } from "@/lib/api";
import { auth, useAuth } from "@/lib/auth";
import { describeUserAgent } from "@/lib/user-agent";
import { cn, errorMessage, timeAgo } from "@/lib/utils";

export const Route = createFileRoute("/_app/_workspace/settings/security")({
  component: SecuritySettings,
});

function SecuritySettings() {
  // Other tabs or sessions may have changed 2FA or used recovery codes.
  useEffect(() => {
    void auth.refresh();
  }, []);
  const sessions = useSessions();

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-base font-semibold tracking-tight">Security</h1>
        <p className="text-xs text-muted-foreground">
          Your account can open a shell on every enrolled device, so keep it locked down.
        </p>
      </div>
      <PasswordSection onChanged={sessions.reload} />
      <TwoFactorSection />
      <SessionsSection {...sessions} />
      <ConnectionsSection />
    </div>
  );
}

function Section({
  title,
  description,
  children,
  aside,
}: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  aside?: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border bg-card">
      <header className="flex items-start gap-3 border-b px-4 py-3 max-sm:flex-wrap">
        <div className="min-w-0 flex-1">
          <h2 className="font-medium">{title}</h2>
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
        {aside}
      </header>
      <div className="px-4 py-4">{children}</div>
    </section>
  );
}

// --- password ----------------------------------------------------------------------

function PasswordSection({ onChanged }: { onChanged: () => void }) {
  const username = useAuth()?.user?.username ?? "";
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [touched, setTouched] = useState({ next: false, confirm: false });
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const lengthProblem =
    next.length < PASSWORD_MIN
      ? `At least ${PASSWORD_MIN} characters.`
      : next.length > PASSWORD_MAX
        ? `At most ${PASSWORD_MAX} characters.`
        : null;
  const matchProblem = confirm && confirm !== next ? "Passwords don't match." : null;
  const valid = current && !lengthProblem && confirm === next;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched({ next: true, confirm: true });
    if (!valid) return;
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await api.changePassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      setTouched({ next: false, confirm: false });
      setDone(true);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Password" description="Changing it signs out every other session and connected app.">
      <form onSubmit={submit} className="flex max-w-sm flex-col gap-3">
        {/* Lets password managers attach the new password to the right account. */}
        <input type="text" autoComplete="username" value={username} readOnly hidden />
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pw-current">Current password</Label>
          <Input
            id="pw-current"
            type="password"
            autoComplete="current-password"
            required
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pw-new">New password</Label>
          <Input
            id="pw-new"
            type="password"
            autoComplete="new-password"
            required
            maxLength={PASSWORD_MAX}
            aria-invalid={touched.next && !!lengthProblem}
            value={next}
            onChange={(e) => {
              setNext(e.target.value);
              setDone(false);
            }}
            onBlur={() => next && setTouched((t) => ({ ...t, next: true }))}
          />
          <p className={cn("text-xs", touched.next && lengthProblem ? "text-destructive" : "text-muted-foreground")}>
            {touched.next && lengthProblem ? lengthProblem : PASSWORD_HINT}
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pw-confirm">Confirm new password</Label>
          <Input
            id="pw-confirm"
            type="password"
            autoComplete="new-password"
            required
            aria-invalid={touched.confirm && !!matchProblem}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            onBlur={() => confirm && setTouched((t) => ({ ...t, confirm: true }))}
          />
          {touched.confirm && matchProblem && <p className="text-xs text-destructive">{matchProblem}</p>}
        </div>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        {done && (
          <p role="status" className="flex items-center gap-1.5">
            <CheckIcon className="size-3.5 text-live" />
            Password changed. Other sessions were signed out.
          </p>
        )}
        <div>
          <Button type="submit" size="sm" disabled={busy}>
            Change password
          </Button>
        </div>
      </form>
    </Section>
  );
}

// --- two-factor ----------------------------------------------------------------------

const LOW_RECOVERY_CODES = 3;

function TwoFactorSection() {
  const user = useAuth()?.user;
  const [dialog, setDialog] = useState<"setup" | "regenerate" | "disable" | null>(null);
  const close = (o: boolean) => !o && setDialog(null);
  const enabled = !!user?.totpEnabled;
  const left = user?.recoveryCodesLeft ?? 0;
  const low = left <= LOW_RECOVERY_CODES;

  return (
    <Section
      title="Two-factor authentication"
      description="Require a code from an authenticator app when signing in."
      aside={
        user && (
          <span
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-sm px-1.5 py-0.5 text-xs",
              enabled ? "bg-primary/10 text-primary" : "bg-muted-foreground/10 text-muted-foreground",
            )}
          >
            {enabled ? <ShieldCheckIcon className="size-3.5" /> : <ShieldOffIcon className="size-3.5" />}
            {enabled ? "On" : "Off"}
          </span>
        )
      }
    >
      {!user ? null : enabled ? (
        <div className="flex flex-col gap-3">
          <div
            className={cn(
              "flex items-start gap-2 rounded-md border px-3 py-2",
              low ? "border-warn/30 bg-warn/10 text-warn" : "bg-background/40",
            )}
          >
            {low && <TriangleAlertIcon className="mt-px size-3.5 shrink-0" />}
            <p className={cn(!low && "text-muted-foreground")}>
              <span className={cn("font-medium tabular-nums", !low && "text-foreground")}>
                {left} of 10 recovery codes left.
              </span>{" "}
              {left === 0
                ? "If you lose your authenticator you won't be able to sign in. Generate new codes now."
                : low
                  ? "Generate new ones before you run out."
                  : "Each one signs you in once if you lose your authenticator."}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant={low ? "default" : "outline"} onClick={() => setDialog("regenerate")}>
              Regenerate recovery codes
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => setDialog("disable")}
            >
              Turn off
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-muted-foreground">
            With it on, a leaked password alone isn't enough to get into your devices.
          </p>
          <Button size="sm" onClick={() => setDialog("setup")}>
            Set up
          </Button>
        </div>
      )}
      <SetupTwoFactorDialog open={dialog === "setup"} onOpenChange={close} />
      <RegenerateCodesDialog open={dialog === "regenerate"} onOpenChange={close} />
      <DisableTwoFactorDialog open={dialog === "disable"} onOpenChange={close} />
    </Section>
  );
}

// --- sessions -----------------------------------------------------------------------

interface SessionsState {
  sessions: Session[] | undefined;
  error: string | null;
  reload: () => void;
  setSessions: React.Dispatch<React.SetStateAction<Session[] | undefined>>;
}

function useSessions(): SessionsState {
  const [sessions, setSessions] = useState<Session[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    let cancelled = false;
    api
      .sessions()
      .then((list) => {
        if (cancelled) return;
        setSessions(list);
        setError(null);
      })
      .catch((e: unknown) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [tick]);
  return { sessions, error, reload, setSessions };
}

const MOBILE_UA = /iPhone|iPad|iPod|Android|Mobile/;

function SessionsSection({ sessions, error, reload, setSessions }: SessionsState) {
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const sorted = sessions
    ? [...sessions].sort((a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt - a.lastSeenAt)
    : undefined;
  const others = sorted?.filter((s) => !s.current).length ?? 0;

  async function revoke(id: string) {
    setBusy(id);
    setActionError(null);
    try {
      await api.revokeSession(id);
      setSessions((list) => list?.filter((s) => s.id !== id));
    } catch (e) {
      setActionError(errorMessage(e));
      reload();
    } finally {
      setBusy(null);
    }
  }

  return (
    <Section
      title="Sessions"
      description="Browsers signed in to this account. Signing one out also closes its terminals."
      aside={
        others > 0 && (
          <Button size="sm" variant="outline" className="shrink-0" onClick={() => setConfirmAll(true)}>
            <LogOutIcon />
            Sign out all other sessions
          </Button>
        )
      }
    >
      {error && !sessions && <p className="text-destructive">Couldn't load sessions: {error}</p>}
      {!sorted && !error && <p className="text-muted-foreground">Loading…</p>}
      {sorted && (
        <ul className="-my-2 divide-y">
          {sorted.map((s) => {
            const Icon = s.userAgent && MOBILE_UA.test(s.userAgent) ? SmartphoneIcon : MonitorIcon;
            return (
              <li key={s.id} className="flex items-center gap-3 py-2">
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium" title={s.userAgent ?? undefined}>
                      {describeUserAgent(s.userAgent)}
                    </span>
                    {s.current && (
                      <span className="shrink-0 rounded-sm bg-primary/10 px-1.5 py-px text-[11px] text-primary">
                        This browser
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Signed in {timeAgo(s.createdAt)} · {s.current ? "active now" : `last active ${timeAgo(s.lastSeenAt)}`}
                  </div>
                </div>
                {!s.current && (
                  <Button size="sm" variant="ghost" disabled={busy === s.id} onClick={() => revoke(s.id)}>
                    Sign out
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {actionError && (
        <p role="alert" className="mt-3 text-destructive">
          {actionError}
        </p>
      )}
      <ConfirmDialog
        open={confirmAll}
        onOpenChange={setConfirmAll}
        title="Sign out all other sessions?"
        confirmLabel="Sign out others"
        description={
          <p>
            Every browser except this one is signed out immediately and its open terminals are disconnected. Shells
            keep running on your devices.
          </p>
        }
        onConfirm={async () => {
          await api.revokeOtherSessions();
          setSessions((list) => list?.filter((s) => s.current));
        }}
      />
    </Section>
  );
}

// --- connected apps ------------------------------------------------------------------

function ConnectionsSection() {
  const [data, setData] = useState<{ mcpUrl: string; connections: Connection[] } | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .connections()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);

  async function revoke(id: string) {
    setBusy(id);
    setError(null);
    try {
      await api.revokeConnection(id);
      setData((d) => d && { ...d, connections: d.connections.filter((c) => c.id !== id) });
    } catch (e) {
      setError(errorMessage(e));
      load();
    } finally {
      setBusy(null);
    }
  }

  return (
    <Section
      title="Connected apps"
      description={
        <>
          AI agents like ChatGPT can use your devices, projects and threads over MCP. Add this URL as a connector
          (in ChatGPT: Settings → Apps &amp; Connectors, with developer mode on), then sign in here to approve it.
        </>
      }
    >
      {data && (
        <div className="mb-4 flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-md border bg-terminal px-2.5 py-1.5 font-mono text-xs">
            {data.mcpUrl}
          </code>
          <CopyButton text={data.mcpUrl} />
        </div>
      )}
      {!data && !error && <p className="text-muted-foreground">Loading…</p>}
      {data && data.connections.length === 0 && <p className="text-muted-foreground">No apps connected.</p>}
      {data && data.connections.length > 0 && (
        <ul className="-my-2 divide-y">
          {data.connections.map((c) => (
            <li key={c.id} className="flex items-center gap-3 py-2">
              <BotIcon className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">
                  {c.name}
                  {c.hosts.length > 0 && <span className="font-normal text-muted-foreground"> · {c.hosts.join(", ")}</span>}
                </div>
                <div className="text-xs text-muted-foreground">
                  Connected {timeAgo(c.createdAt)} · {c.lastUsedAt ? `last used ${timeAgo(c.lastUsedAt)}` : "not used yet"}
                </div>
              </div>
              <Button size="sm" variant="ghost" disabled={busy === c.id} onClick={() => revoke(c.id)}>
                Disconnect
              </Button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="mt-3 text-destructive">
          {error}
        </p>
      )}
    </Section>
  );
}
