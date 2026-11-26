import { createFileRoute } from "@tanstack/react-router";
import { CheckIcon, KeyRoundIcon } from "lucide-react";
import { useState } from "react";
import type { DeviceContextValue } from "@/components/device-context";
import { useFleet } from "@/components/fleet";
import { HarnessSignIn, useHarnessAuth } from "@/components/harness-auth";
import { PresenceDot } from "@/components/presence-dot";
import { Section } from "@/components/settings-section";
import { Button } from "@/components/ui/button";
import type { Device } from "@/lib/api";

export const Route = createFileRoute("/_app/_workspace/settings/antigravity")({
  component: AntigravitySettings,
});

const KIND = "antigravity";
const TITLE = "Antigravity";

/** Antigravity's Google sign-in on each device, from here. */
function AntigravitySettings() {
  const { devices, entries } = useFleet();
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-base font-semibold tracking-tight">Antigravity</h1>
        <p className="text-xs text-muted-foreground">
          Google's coding agent, on devices with the Antigravity CLI (<code className="font-mono">agy</code>) installed.
        </p>
      </div>
      <Section
        title="Google sign-in"
        description="Antigravity uses the Google account it's signed in with on each device, and that account's plan. Sign a device in here: Google's page opens in this browser and ends on a code to paste back."
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
    </div>
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
    <li className="flex items-center gap-3 py-2 max-sm:flex-wrap">
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
  const supported = !!entry.info.data?.features?.includes("harnessAuth");
  const auth = useHarnessAuth(entry, KIND);
  const [signingIn, setSigningIn] = useState(false);
  const a = auth.data;

  let note: React.ReactNode;
  let action: React.ReactNode = null;
  if (!connected) note = entry.conn.state === "connecting" ? "Connecting…" : "Offline";
  else if (!entry.info.data) note = "Connecting…";
  else if (!supported) note = "Update everywhere on this device to sign Antigravity in from here.";
  else if (!a) note = "Checking…";
  else if (!a.installed) note = "The Antigravity CLI isn't installed (antigravity.google).";
  else if (!a.known) note = a.problem ? `Couldn't ask Antigravity: ${a.problem}` : "Antigravity can't say whether it's signed in.";
  else if (a.signedIn)
    note = (
      <span className="inline-flex items-center gap-1 text-live">
        <CheckIcon className="size-3" />
        Signed in with Google
      </span>
    );
  else note = a.signingIn ? "A sign-in is waiting for its code." : "Not signed in";

  if (supported && a?.installed && a.canSignIn && a.known) {
    action = (
      <Button
        size="sm"
        variant={a.signedIn ? "outline" : "secondary"}
        className="shrink-0"
        onClick={() => setSigningIn(true)}
      >
        <KeyRoundIcon />
        {a.signedIn ? "Sign in again" : "Sign in with Google"}
      </Button>
    );
  }

  return (
    <DeviceLine device={device} online={connected} note={note}>
      {action}
      <HarnessSignIn
        entry={entry}
        kind={KIND}
        title={TITLE}
        open={signingIn}
        onOpenChange={setSigningIn}
        onDone={auth.refetch}
      />
    </DeviceLine>
  );
}
