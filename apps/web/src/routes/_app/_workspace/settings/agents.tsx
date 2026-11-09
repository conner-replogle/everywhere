import { createFileRoute, Link } from "@tanstack/react-router";
import { CircleAlertIcon, KeyRoundIcon, PlusIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyButton } from "@/components/copy-button";
import type { DeviceContextValue } from "@/components/device-context";
import { useFleet } from "@/components/fleet";
import { PresenceDot } from "@/components/presence-dot";
import { Section } from "@/components/settings-section";
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
import { Switch } from "@/components/ui/switch";
import {
  type AgentActivity,
  type AgentKey,
  type AgentScope,
  type AgentsStatus,
  api,
  ApiError,
  type Device,
  type NewAgentKey,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useRpc } from "@/lib/peer";
import { looksLikeCode, normalizeCode } from "@/lib/totp";
import { cn, errorMessage, timeAgo } from "@/lib/utils";

export const Route = createFileRoute("/_app/_workspace/settings/agents")({
  component: AgentsSettings,
});

/** What each scope lets a key do, in words. */
const SCOPES: Record<AgentScope, string> = {
  read: "read threads",
  drive: "prompt, start and stop Claude threads",
  projects: "create projects",
};

/** The MCP tools, in words; others show their own name. */
const TOOLS: Record<string, string> = {
  list_devices: "listed devices",
  list_projects: "listed projects",
  list_directories: "listed folders",
  create_project: "created a project",
  list_threads: "listed threads",
  search_threads: "searched threads",
  read_thread: "read a thread",
  get_attachment: "read a thread's file",
  create_thread: "started a thread",
  send_message: "sent a prompt",
  interrupt_thread: "stopped a turn",
  update_thread: "changed a thread",
};

const EXPIRY = [7, 30, 90] as const;

const ACTIVITY_PAGE = 30;

function toolWords(tool: string) {
  return TOOLS[tool] ?? tool.replaceAll("_", " ");
}

/** "in 3d", "in 5h": the counterpart to timeAgo for expiry. */
function timeUntil(ms: number, now = Date.now()) {
  const m = Math.round((ms - now) / 60_000);
  if (m <= 0) return "now";
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `in ${h}h`;
  return `in ${Math.round(h / 24)}d`;
}

function deviceNames(ids: string[], devices: Device[] | undefined) {
  if (ids.length === 0) return "no devices";
  return ids.map((id) => devices?.find((d) => d.id === id)?.name ?? "a removed device").join(", ");
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-terminal px-1 py-0.5 font-mono text-xs text-foreground">{children}</code>;
}

function AgentsSettings() {
  const [status, setStatus] = useState<AgentsStatus | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .agents()
      .then((s) => {
        setStatus(s);
        setError(null);
      })
      .catch((e: unknown) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-base font-semibold tracking-tight">Connected agents</h1>
        <p className="text-xs text-muted-foreground">
          Let AI agents read your threads and work in them over MCP, with an API key for the devices you pick.
        </p>
      </div>
      {error && !status && <p className="text-destructive">Couldn't load connected agents: {error}</p>}
      {!status && !error && <p className="text-muted-foreground">Loading…</p>}
      {status && (
        <>
          <AccountSection status={status} onChanged={load} />
          <DevicesSection accountOn={status.enabled} />
          {status.enabled && (
            <KeysSection
              status={status}
              onCreated={(key) => setStatus((s) => s && { ...s, keys: [key, ...s.keys] })}
              onDeleted={(id) => setStatus((s) => s && { ...s, keys: s.keys.filter((k) => k.id !== id) })}
            />
          )}
          <ActivitySection />
        </>
      )}
    </div>
  );
}

// --- password and 2FA again ------------------------------------------------------------

/** The password, plus a 2FA code when the account has 2FA or the Worker asks for one. */
function useReauth(open: boolean) {
  const totp = !!useAuth()?.user?.totpEnabled;
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needsCode, setNeedsCode] = useState(totp);

  useEffect(() => {
    if (!open) return;
    setPassword("");
    setCode("");
    setNeedsCode(totp);
  }, [open, totp]);

  return {
    password,
    code,
    needsCode,
    setPassword,
    setCode,
    ready: !!password && (!needsCode || looksLikeCode(code)),
    creds: () => ({ password, ...(needsCode ? { code: normalizeCode(code) } : {}) }),
    /** What to show for a failed request; null when it only asked for the code. */
    failed(err: unknown): string | null {
      if (err instanceof ApiError && err.body.needsCode) {
        const first = !needsCode;
        setNeedsCode(true);
        setCode("");
        return first ? null : err.message;
      }
      return errorMessage(err);
    },
  };
}

function ReauthFields({ r, id }: { r: ReturnType<typeof useReauth>; id: string }) {
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-password`}>Password</Label>
        <Input
          id={`${id}-password`}
          type="password"
          autoComplete="current-password"
          required
          value={r.password}
          onChange={(e) => r.setPassword(e.target.value)}
        />
      </div>
      {r.needsCode && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-code`}>Authenticator or recovery code</Label>
          <Input
            id={`${id}-code`}
            autoComplete="one-time-code"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            autoFocus={!!r.password}
            value={r.code}
            onChange={(e) => r.setCode(e.target.value)}
          />
        </div>
      )}
    </>
  );
}

// --- the account switch --------------------------------------------------------------

function Risks() {
  return (
    <ul className="grid list-disc gap-1.5 pl-4">
      <li>An agent with one of your keys acts as you on the devices you picked for that key.</li>
      <li>
        Whatever it reads (your prompts, Claude's replies, code and files in threads) goes to whoever runs that agent.
      </li>
      <li>
        Text in a thread or on a web page can try to steer the agent into doing something you didn't ask for (prompt
        injection).
      </li>
      <li>
        It can start and prompt Claude threads. They run with the thread's permission mode, and Claude still asks you
        before risky steps.
      </li>
      <li>It can't run commands, read other files, use terminals, or answer Claude's permission prompts.</li>
    </ul>
  );
}

function AccountSection({ status, onChanged }: { status: AgentsStatus; onChanged: () => void }) {
  const [dialog, setDialog] = useState<"enable" | "disable" | null>(null);
  const close = (o: boolean) => !o && setDialog(null);

  return (
    <Section
      title="For this account"
      description={
        status.enabled
          ? `On${status.enabledAt ? ` since ${timeAgo(status.enabledAt)}` : ""}. Agents with a key can reach the devices allowed below.`
          : "Off: no key works, and nothing answers at the MCP endpoint."
      }
      aside={
        <Switch
          aria-label="Connected agents for this account"
          checked={status.enabled}
          onCheckedChange={(on) => setDialog(on ? "enable" : "disable")}
        />
      }
    >
      {status.enabled ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border bg-terminal px-2.5 py-1.5 font-mono text-xs">
              {status.mcpUrl}
            </code>
            <CopyButton text={status.mcpUrl} />
          </div>
          <p className="text-xs text-muted-foreground">Create a key below and add it to your MCP client.</p>
        </div>
      ) : (
        <p className="text-muted-foreground">
          Turn this on to create API keys for agents. You'll confirm with your password.
        </p>
      )}
      <EnableDialog
        open={dialog === "enable"}
        onOpenChange={close}
        onEnabled={() => {
          setDialog(null);
          onChanged();
        }}
      />
      <ConfirmDialog
        open={dialog === "disable"}
        onOpenChange={close}
        title="Turn off connected agents?"
        confirmLabel="Turn off"
        description={
          <p>
            Every key is deleted at once and the MCP endpoint stops answering. To connect an agent again, you'll turn
            this back on and create a new key.
          </p>
        }
        onConfirm={async () => {
          await api.disableAgents();
          onChanged();
        }}
      />
    </Section>
  );
}

function EnableDialog({
  open,
  onOpenChange,
  onEnabled,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onEnabled: () => void;
}) {
  const r = useReauth(open);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(false);
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { password, code } = r.creds();
      await api.enableAgents(password, code);
      onEnabled();
    } catch (err) {
      setError(r.failed(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Turn on connected agents?</DialogTitle>
            <DialogDescription asChild>
              <div className="grid gap-2">
                <Risks />
                <p>Only give keys to agents you trust, and give each key only the devices it needs.</p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <ReauthFields r={r} id="agents-enable" />
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !r.ready}>
              Turn on
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- each device's switch ------------------------------------------------------------

function DevicesSection({ accountOn }: { accountOn: boolean }) {
  const { devices, entries } = useFleet();
  return (
    <Section
      title="Devices"
      description={
        <>
          An agent reaches a device only while connected agents are on for the account
          {accountOn ? "" : " (they're off now)"}, on that device, and for its key. Only you can turn a device on, here
          or on the device with <Code>everywhere agents enable</Code>.
        </>
      }
    >
      {!devices && <p className="text-muted-foreground">Loading…</p>}
      {devices?.length === 0 && <p className="text-muted-foreground">No devices enrolled.</p>}
      {devices && devices.length > 0 && (
        <ul className="-my-2 divide-y">
          {devices.map((d) => {
            const entry = entries.get(d.id);
            return entry ? (
              <DeviceRow key={d.id} device={d} entry={entry} />
            ) : (
              <DeviceLine key={d.id} device={d} online={false} note="Offline" />
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function DeviceLine({
  device,
  online,
  note,
  children,
}: {
  device: Device;
  online: boolean | undefined;
  note: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <li className="flex items-center gap-3 py-2">
      <PresenceDot online={online} />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{device.name}</div>
        <div className="text-xs text-muted-foreground">{note}</div>
      </div>
      {children}
    </li>
  );
}

function DeviceRow({ device, entry }: { device: Device; entry: DeviceContextValue }) {
  const connected = entry.conn.state === "connected";
  const supported = !!entry.info.data?.features?.includes("agents");
  const agents = useRpc(entry.peer, "device.agents", {}, [], connected && supported);
  // Set from device.setAgents' answer until the next fetch.
  const [enabled, setEnabled] = useState<boolean | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => setEnabled(agents.data?.enabled), [agents.data]);

  async function turnOff() {
    setBusy(true);
    setError(null);
    try {
      setEnabled((await entry.peer.call("device.setAgents", { enabled: false })).enabled);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  let note: React.ReactNode;
  if (!connected) note = entry.conn.state === "connecting" ? "Connecting…" : "Offline";
  else if (!entry.info.data) note = "Connecting…";
  else if (!supported) note = "Update everywhere on this device to use connected agents.";
  else if (agents.error && enabled === undefined) note = <span className="text-destructive">{agents.error}</span>;
  else if (enabled === undefined) note = "Checking…";
  else note = enabled ? "Agents with a key for this device can reach it." : "Off: no agent can reach this device.";

  return (
    <DeviceLine device={device} online={connected} note={error ? <span className="text-destructive">{error}</span> : note}>
      <Switch
        aria-label={`Connected agents on ${device.name}`}
        checked={!!enabled}
        disabled={!connected || !supported || enabled === undefined || busy}
        onCheckedChange={(on) => (on ? setConfirming(true) : void turnOff())}
      />
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Allow connected agents on ${device.name}?`}
        confirmLabel="Allow"
        confirmVariant="default"
        description={
          <>
            <p>
              Agents with a key for this device can read its threads and prompt Claude there. What they read goes to
              whoever runs the agent, and text in a thread or a web page can try to steer them.
            </p>
            <p>They can't run commands, read other files, use terminals, or answer Claude's permission prompts.</p>
          </>
        }
        onConfirm={async () => {
          const r = await entry.peer.call("device.setAgents", { enabled: true });
          setEnabled(r.enabled);
        }}
      />
    </DeviceLine>
  );
}

// --- API keys ------------------------------------------------------------------------

function KeysSection({
  status,
  onCreated,
  onDeleted,
}: {
  status: AgentsStatus;
  onCreated: (key: AgentKey) => void;
  onDeleted: (id: string) => void;
}) {
  const { devices } = useFleet();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<AgentKey | null>(null);

  return (
    <Section
      title="API keys"
      description="Each key works until it expires or you delete it. Threads show its name on the prompts it sends."
      aside={
        <Button size="sm" variant="outline" className="shrink-0" onClick={() => setCreating(true)}>
          <PlusIcon />
          New key
        </Button>
      }
    >
      {status.keys.length === 0 && <p className="text-muted-foreground">No keys yet.</p>}
      {status.keys.length > 0 && (
        <ul className="-my-2 divide-y">
          {status.keys.map((k) => (
            <li key={k.id} className="flex items-center gap-3 py-2">
              <KeyRoundIcon className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">
                  {k.name}
                  <span className="font-mono text-xs font-normal text-muted-foreground"> …{k.hint}</span>
                </div>
                <div className="text-xs text-muted-foreground">
                  Can {k.scopes.map((s) => SCOPES[s] ?? s).join(", ")} on {deviceNames(k.devices, devices)}
                </div>
                <div className="text-xs text-muted-foreground">
                  Created {timeAgo(k.createdAt)} · {k.lastUsedAt ? `last used ${timeAgo(k.lastUsedAt)}` : "not used yet"} ·
                  expires {timeUntil(k.expiresAt)}
                </div>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setDeleting(k)}>
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}
      <NewKeyDialog open={creating} onOpenChange={setCreating} mcpUrl={status.mcpUrl} onCreated={onCreated} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.name ?? "key"}?`}
        confirmLabel="Delete key"
        description={<p>Agents using it lose access at once. Its activity stays listed below.</p>}
        onConfirm={async () => {
          if (!deleting) return;
          await api.deleteAgentKey(deleting.id);
          onDeleted(deleting.id);
        }}
      />
    </Section>
  );
}

function Check({
  checked,
  disabled,
  onChange,
  children,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange?: (on: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <label className={cn("flex items-center gap-2", disabled && "text-muted-foreground")}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange?.(e.target.checked)} />
      {children}
    </label>
  );
}

function NewKeyDialog({
  open,
  onOpenChange,
  mcpUrl,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  mcpUrl: string;
  onCreated: (key: AgentKey) => void;
}) {
  const { devices } = useFleet();
  const r = useReauth(open);
  const [name, setName] = useState("");
  const [drive, setDrive] = useState(true);
  const [projects, setProjects] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [expiry, setExpiry] = useState<NewAgentKey["expiresInDays"]>(30);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ key: AgentKey; secret: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setDrive(true);
    setProjects(false);
    setPicked([]);
    setExpiry(30);
    setError(null);
    setBusy(false);
    setCreated(null);
  }, [open]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const scopes: AgentScope[] = ["read", ...(drive ? (["drive"] as const) : []), ...(projects ? (["projects"] as const) : [])];
      const res = await api.createAgentKey({ name: name.trim(), scopes, devices: picked, expiresInDays: expiry, ...r.creds() });
      setCreated(res);
      onCreated(res.key);
    } catch (err) {
      setError(r.failed(err));
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    const header = `Authorization: Bearer ${created.secret}`;
    const command = `claude mcp add --transport http everywhere ${mcpUrl} --header "${header}"`;
    const json = JSON.stringify(
      { mcpServers: { everywhere: { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${created.secret}` } } } },
      null,
      2,
    );
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{created.key.name} is ready</DialogTitle>
            <DialogDescription>
              Copy the key now: it won't be shown again. If you lose it, delete it and create a new one.
            </DialogDescription>
          </DialogHeader>
          <div className="grid min-w-0 gap-4">
            <Snippet label="Key" text={created.secret} />
            <Snippet label="Claude Code" text={command} />
            <Snippet label="Other MCP clients" text={json} />
          </div>
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>New API key</DialogTitle>
            <DialogDescription>
              An agent with this key acts as you on the devices you pick. What it reads goes to whoever runs it, and text
              in a thread or a web page can try to steer it. It can't run commands, read other files, use terminals, or
              answer Claude's permission prompts.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="agent-key-name">Name</Label>
            <Input
              id="agent-key-name"
              placeholder="Claude Code on my laptop"
              autoFocus
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">Prompts it sends show "via" this name.</p>
          </div>
          <fieldset className="grid gap-1.5">
            <legend className="mb-1.5 text-xs font-medium text-muted-foreground">It can</legend>
            <Check checked disabled>
              Read threads
            </Check>
            <Check checked={drive} onChange={setDrive}>
              Prompt, start and stop Claude threads
            </Check>
            <Check checked={projects} onChange={setProjects}>
              Create projects
            </Check>
          </fieldset>
          <fieldset className="grid gap-1.5">
            <legend className="mb-1.5 text-xs font-medium text-muted-foreground">On these devices</legend>
            {devices?.length === 0 && <p className="text-muted-foreground">No devices enrolled.</p>}
            {devices?.map((d) => (
              <Check
                key={d.id}
                checked={picked.includes(d.id)}
                onChange={(on) => setPicked((p) => (on ? [...p, d.id] : p.filter((id) => id !== d.id)))}
              >
                {d.name}
              </Check>
            ))}
          </fieldset>
          <fieldset className="grid gap-1.5">
            <legend className="mb-1.5 text-xs font-medium text-muted-foreground">Expires after</legend>
            <div className="flex w-fit rounded-md border p-0.5 text-xs" role="radiogroup">
              {EXPIRY.map((days) => (
                <button
                  key={days}
                  type="button"
                  role="radio"
                  aria-checked={expiry === days}
                  onClick={() => setExpiry(days)}
                  className={cn(
                    "rounded-sm px-2.5 py-1",
                    expiry === days ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {days} days
                </button>
              ))}
            </div>
          </fieldset>
          <ReauthFields r={r} id="agent-key" />
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim() || picked.length === 0 || !r.ready}>
              Create key
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Snippet({ label, text }: { label: string; text: string }) {
  return (
    <div className="grid min-w-0 gap-1.5">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-xs font-medium text-muted-foreground">{label}</span>
        <CopyButton text={text} />
      </div>
      <pre className="overflow-x-auto rounded-md border bg-terminal px-2.5 py-1.5 font-mono text-xs whitespace-pre-wrap break-all">
        {text}
      </pre>
    </div>
  );
}

// --- recent activity ------------------------------------------------------------------

function ActivitySection() {
  const { devices, entries: fleet } = useFleet();
  const [entries, setEntries] = useState<AgentActivity[] | undefined>(undefined);
  const [next, setNext] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (cursor?: string) => {
    setBusy(true);
    try {
      const page = await api.agentActivity({ cursor, limit: ACTIVITY_PAGE });
      setEntries((prev) => [...(cursor === undefined ? [] : (prev ?? [])), ...page.entries]);
      setNext(page.next);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const threadName = (a: AgentActivity) =>
    a.deviceId && a.threadId ? fleet.get(a.deviceId)?.threads.data?.find((t) => t.id === a.threadId)?.name : undefined;

  return (
    <Section title="Recent activity" description="What agents did with your keys, newest first.">
      {error && !entries && <p className="text-destructive">Couldn't load activity: {error}</p>}
      {!entries && !error && <p className="text-muted-foreground">Loading…</p>}
      {entries?.length === 0 && <p className="text-muted-foreground">Nothing yet.</p>}
      {entries && entries.length > 0 && (
        <ul className="-my-1 divide-y text-xs">
          {entries.map((a) => {
            const device = a.deviceId ? devices?.find((d) => d.id === a.deviceId) : undefined;
            return (
              <li key={a.id} className="flex items-baseline gap-3 py-1.5">
                <span className="w-16 shrink-0 text-muted-foreground tabular-nums" title={new Date(a.at).toLocaleString()}>
                  {timeAgo(a.at)}
                </span>
                <div className="min-w-0 flex-1">
                  <span className="font-medium">{a.key}</span> {toolWords(a.tool)}
                  {a.deviceId && (
                    <span className="text-muted-foreground"> on {device?.name ?? "a removed device"}</span>
                  )}
                  {a.deviceId && a.threadId && (
                    <>
                      <span className="text-muted-foreground"> in </span>
                      <Link
                        to="/d/$deviceId/t/$threadId"
                        params={{ deviceId: a.deviceId, threadId: a.threadId }}
                        className="underline-offset-2 hover:underline"
                      >
                        {threadName(a) ?? "a thread"}
                      </Link>
                    </>
                  )}
                  {!a.ok && (
                    <div className="flex items-start gap-1 text-destructive">
                      <CircleAlertIcon className="mt-px size-3 shrink-0" />
                      <span className="min-w-0 break-words">Failed{a.error ? `: ${a.error}` : ""}</span>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {entries && error && (
        <p role="alert" className="mt-3 flex items-center gap-1.5 text-destructive">
          <TriangleAlertIcon className="size-3.5" />
          {error}
        </p>
      )}
      {entries && next && (
        <div className="mt-3">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void load(next)}>
            Load more
          </Button>
        </div>
      )}
    </Section>
  );
}
