import { createFileRoute } from "@tanstack/react-router";
import { BellIcon, BellOffIcon, CheckIcon, SendIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Section } from "@/components/settings-section";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { currentPushSubscription, disablePush, enablePush, pushSupport } from "@/lib/pwa";
import { errorMessage } from "@/lib/utils";

export const Route = createFileRoute("/_app/_workspace/settings/notifications")({
  component: NotificationSettings,
});

function NotificationSettings() {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-base font-semibold tracking-tight">Notifications</h1>
        <p className="text-xs text-muted-foreground">
          Hear about claude threads when you're not looking at them.
        </p>
      </div>
      <PushSection />
    </div>
  );
}

function PushSection() {
  const support = pushSupport();
  // undefined while checking.
  const [sub, setSub] = useState<PushSubscription | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState(false);

  useEffect(() => {
    currentPushSubscription()
      .then(setSub)
      .catch(() => setSub(null));
  }, []);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setTested(false);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const on = !!sub;
  return (
    <Section
      title="This device"
      description="When a claude thread asks for permission, has a question or a plan for you, or finishes a turn. Notifications show the thread's name and device, never its content."
      aside={
        support === "ok" &&
        sub !== undefined &&
        (on ? (
          <Button variant="outline" size="sm" disabled={busy} onClick={() =>
              run(async () => {
                await disablePush();
                setSub(null);
              })
            }>
            <BellOffIcon />
            Turn off
          </Button>
        ) : (
          <Button size="sm" disabled={busy} onClick={() => run(async () => setSub(await enablePush()))}>
            <BellIcon />
            Turn on
          </Button>
        ))
      }
    >
      {support === "install" && (
        <p className="text-muted-foreground">
          On iPhone and iPad, add everywhere to your Home Screen first (Share → Add to Home Screen), then open it
          from there and turn notifications on.
        </p>
      )}
      {support === "unsupported" && <p className="text-muted-foreground">This browser can't receive notifications.</p>}
      {support === "ok" && (
        <div className="flex flex-col gap-3">
          <p className="text-muted-foreground">
            {sub === undefined
              ? "Checking…"
              : on
                ? "On for this device. Nothing is sent about the thread you have open."
                : "Off for this device. Turn them on on each device you want them on."}
          </p>
          {on && (
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await api.testPush(sub.endpoint);
                    setTested(true);
                  })
                }
              >
                <SendIcon />
                Send a test
              </Button>
              {tested && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <CheckIcon className="size-3.5" />
                  Sent
                </span>
              )}
            </div>
          )}
        </div>
      )}
      {error && <p className="mt-3 text-destructive">{error}</p>}
    </Section>
  );
}
