import { ExternalLinkIcon, GlobeIcon, RotateCwIcon, ShieldAlertIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { framingBlocked } from "@/lib/web-tabs";

/**
 * A web page in a tab, loaded by this browser in an iframe: a process's web
 * UI, a link from Claude. Sites that refuse to be framed show blank; the
 * toolbar opens them in a browser tab instead.
 */
export function WebView({ url }: { url: string }) {
  const [reloads, setReloads] = useState(0);
  const blocked = framingBlocked(url);
  const openOutside = () => window.open(url, "_blank", "noopener,noreferrer");
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b px-2">
        <GlobeIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs select-all" title={url}>
          {url}
        </span>
        {!blocked && (
          <Button variant="ghost" size="icon-sm" aria-label="Reload" title="Reload" onClick={() => setReloads((n) => n + 1)}>
            <RotateCwIcon />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Open in a new browser tab"
          title="Open in a new browser tab (for a page that stays blank here: some sites refuse to be shown inside another page)"
          onClick={openOutside}
        >
          <ExternalLinkIcon />
        </Button>
      </div>
      {blocked ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="grid max-w-md justify-items-center gap-3 text-center text-sm">
            <ShieldAlertIcon className="size-6 text-muted-foreground" />
            <p className="text-muted-foreground">{blocked}</p>
            <Button variant="outline" size="sm" onClick={openOutside}>
              <ExternalLinkIcon />
              Open in a new tab
            </Button>
          </div>
        </div>
      ) : (
        <iframe
          key={reloads}
          src={url}
          title={url}
          className="min-h-0 w-full flex-1 bg-white"
          allow="clipboard-read; clipboard-write; fullscreen"
        />
      )}
    </div>
  );
}
