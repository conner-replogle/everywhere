import { createFileRoute } from "@tanstack/react-router";
import { UnlinkIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { GithubMark } from "@/components/github-mark";
import { Section } from "@/components/settings-section";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/utils";

export const Route = createFileRoute("/_app/_workspace/settings/github")({
  validateSearch: (search: Record<string, unknown>): { result?: string } =>
    typeof search.result === "string" ? { result: search.result } : {},
  component: GithubSettings,
});

function GithubSettings() {
  const { result } = Route.useSearch();
  // undefined while loading.
  const [status, setStatus] = useState<{ configured: boolean; login: string | null } | undefined>();
  const [error, setError] = useState<string | null>(result === "failed" ? "GitHub didn't connect. Try again." : null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.githubStatus().then(setStatus, (e: unknown) => setError(errorMessage(e)));
  }, []);

  const disconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.disconnectGithub();
      setStatus((s) => s && { ...s, login: null });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-base font-semibold tracking-tight">GitHub</h1>
        <p className="text-xs text-muted-foreground">Clone your repositories onto any device as a new project.</p>
      </div>
      <Section
        title="Account"
        description="The token stays on the server. A clone passes it to the device for that one git clone; it isn't saved there."
        aside={
          status?.login ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={disconnect}>
              <UnlinkIcon />
              Disconnect
            </Button>
          ) : status?.configured ? (
            <Button size="sm" asChild>
              <a href={api.githubConnectUrl}>
                <GithubMark />
                Connect GitHub
              </a>
            </Button>
          ) : null
        }
      >
        {status === undefined ? (
          <p className="text-muted-foreground">{error ?? "Loading…"}</p>
        ) : !status.configured ? (
          <p className="text-muted-foreground">
            GitHub isn't set up on this server. Create an OAuth app on GitHub with the callback URL{" "}
            <code className="rounded bg-terminal px-1 py-0.5 font-mono text-xs text-foreground">
              {location.origin}/api/github/callback
            </code>
            , then set the Worker's <code className="font-mono text-xs">GITHUB_CLIENT_ID</code> and{" "}
            <code className="font-mono text-xs">GITHUB_CLIENT_SECRET</code>.
          </p>
        ) : status.login ? (
          <p>
            Connected as <span className="font-medium">{status.login}</span>. Clone a repo from{" "}
            <span className="text-muted-foreground">New project → GitHub</span> in the sidebar.
          </p>
        ) : (
          <p className="text-muted-foreground">Not connected.</p>
        )}
        {error && status !== undefined && <p className="mt-2 text-destructive">{error}</p>}
      </Section>
    </div>
  );
}
