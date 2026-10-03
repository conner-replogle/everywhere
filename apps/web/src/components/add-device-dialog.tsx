import { Link } from "@tanstack/react-router";
import { PlusIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { PresenceDot } from "@/components/presence-dot";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api, type EnrollToken } from "@/lib/api";
import { useDevices } from "@/lib/devices";
import { cn, errorMessage } from "@/lib/utils";

export function AddDeviceButton({ size = "sm" }: { size?: "sm" | "default" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size={size} onClick={() => setOpen(true)}>
        <PlusIcon />
        Add device
      </Button>
      <AddDeviceDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

type Platform = "unix" | "windows";

function formatRemaining(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function AddDeviceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [token, setToken] = useState<EnrollToken | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // Usually the device being added is the one this browser runs on.
  const [platform, setPlatform] = useState<Platform>(() =>
    /Windows/.test(navigator.userAgent) ? "windows" : "unix",
  );
  const { devices } = useDevices();
  // Devices that existed when the link was generated; anything new was just enrolled.
  const known = useRef<Set<string> | null>(null);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      setToken(await api.createEnrollToken());
      setNow(Date.now());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (open) void generate();
    else {
      setToken(null);
      setError(null);
      known.current = null;
    }
  }, [open]);

  if (open && devices && known.current === null) known.current = new Set(devices.map((d) => d.id));

  useEffect(() => {
    if (!token) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [token]);

  const remaining = token ? token.expiresAt - now : 0;
  const expired = token !== null && remaining <= 0;
  const enrolled = known.current && devices?.find((d) => !known.current!.has(d.id));
  const command = token ? (platform === "windows" ? token.windowsCommand : token.command) : "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a device</DialogTitle>
          <DialogDescription>
            Run this on the machine you want to reach. It installs the daemon, enrolls it to your account, and starts
            it as a service. amd64 or arm64.
          </DialogDescription>
        </DialogHeader>

        {enrolled ? (
          <div className="flex items-center gap-2.5 rounded-md border border-live/30 bg-live/5 px-3 py-2.5">
            <PresenceDot online />
            <span>
              <span className="font-medium">{enrolled.name}</span> is enrolled.
            </span>
            <Button asChild size="sm" variant="secondary" className="ml-auto">
              <Link to="/" onClick={() => onOpenChange(false)}>
                See its projects
              </Link>
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div role="tablist" aria-label="Platform" className="grid grid-cols-2 gap-1 rounded-md border bg-background/60 p-0.5">
              <PlatformTab active={platform === "unix"} onClick={() => setPlatform("unix")} label="Linux & macOS" />
              <PlatformTab active={platform === "windows"} onClick={() => setPlatform("windows")} label="Windows" />
            </div>
            <div
              className={
                "relative rounded-md border bg-terminal px-3 py-2.5 font-mono text-[12px] leading-relaxed break-all " +
                (expired ? "text-muted-foreground line-through" : "text-foreground")
              }
            >
              {token ? (
                <>
                  <span className="text-muted-foreground select-none">{platform === "windows" ? "PS> " : "$ "}</span>
                  {command}
                </>
              ) : error ? (
                <span className="text-destructive">{error}</span>
              ) : (
                <span className="text-muted-foreground">Generating install link…</span>
              )}
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              {token && !expired && (
                <span>
                  Works once. Expires in <span className="text-foreground tabular-nums">{formatRemaining(remaining)}</span>
                </span>
              )}
              {expired && <span className="text-warn">This link expired. Generate a new one.</span>}
              <div className="ml-auto flex gap-2">
                {(expired || error) && (
                  <Button size="sm" variant="outline" onClick={generate} disabled={busy}>
                    <RefreshCwIcon />
                    New link
                  </Button>
                )}
                {token && !expired && <CopyButton text={command} />}
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          <p className="mr-auto self-center text-xs text-muted-foreground">
            {enrolled ? "" : token && !expired ? "Waiting for the device to connect…" : ""}
          </p>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {enrolled ? "Done" : "Close"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PlatformTab({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "flex h-7 items-center justify-center rounded-sm text-xs focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none",
        active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}
