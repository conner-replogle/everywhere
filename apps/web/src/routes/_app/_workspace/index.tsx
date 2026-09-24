import { createFileRoute, Link } from "@tanstack/react-router";
import { ShieldIcon, SparklesIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { AddDeviceButton } from "@/components/add-device-dialog";
import { useFleet } from "@/components/fleet";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/_app/_workspace/")({
  component: Home,
});

function Home() {
  const { devices, error } = useFleet();
  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-xl px-4 pt-6">
        <TwoFactorBanner />
      </div>
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="flex max-w-sm flex-col items-center gap-2 text-center">
          {error && !devices ? (
            <p className="text-destructive">Couldn't load devices: {error}</p>
          ) : devices?.length === 0 ? (
            <>
              <h2 className="text-[15px] font-semibold">No devices yet</h2>
              <p className="text-muted-foreground">
                Add a machine with a one-line install. Once its daemon connects, its projects show up in the sidebar.
              </p>
              <div className="mt-2">
                <AddDeviceButton />
              </div>
            </>
          ) : (
            <>
              <SparklesIcon className="size-6 text-muted-foreground" />
              <h2 className="text-[15px] font-semibold">Pick a thread</h2>
              <p className="text-muted-foreground">
                Projects from all your devices are in the sidebar. Press + on a project to start a terminal or a Claude
                thread in it.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const BANNER_DISMISSED_KEY = "ew:dismissed:2fa-banner";

/** A quiet nudge toward 2FA until it's on or the user says no thanks. */
function TwoFactorBanner() {
  const user = useAuth()?.user;
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(BANNER_DISMISSED_KEY) === "1");
  if (!user || user.totpEnabled || dismissed) return null;
  return (
    <div className="mb-4 flex items-center gap-2.5 rounded-lg border border-primary/20 bg-primary/5 py-2 pr-2 pl-3">
      <ShieldIcon className="size-3.5 shrink-0 text-primary" />
      <p className="min-w-0 flex-1 text-xs text-muted-foreground">
        <span className="text-foreground">Turn on two-factor authentication.</span> This account can open a shell on
        every device you enroll.{" "}
        <Link to="/settings/security" className="text-primary underline-offset-4 hover:underline">
          Set it up
        </Link>
      </p>
      <button
        type="button"
        onClick={() => {
          localStorage.setItem(BANNER_DISMISSED_KEY, "1");
          setDismissed(true);
        }}
        className="rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
        aria-label="Dismiss"
        title="Dismiss"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}
