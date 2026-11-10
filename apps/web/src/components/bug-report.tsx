// The bug button, top right on every page: collects a bug report (see
// lib/bug-report.ts) with a note and an optional screenshot, to download,
// copy, or attach to the open thread's composer.

import { BugIcon, CameraIcon, LoaderCircleIcon, SquareTerminalIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { useFleet } from "@/components/fleet";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { sendToComposer } from "@/lib/composer-inbox";
import { desktop } from "@/lib/desktop";
import { errorMessage } from "@/lib/utils";

/** The thread the page shows, if any. */
function openThread(): string | null {
  return /^\/d\/[^/]+\/t\/([^/]+)/.exec(location.pathname)?.[1] ?? null;
}

function fileName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `everywhere-bug-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.json`;
}

export function BugReport() {
  const { devices, entries } = useFleet();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [threadMessages, setThreadMessages] = useState(true);
  const [screenshot, setScreenshot] = useState<string>();
  const [capturing, setCapturing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const thread = open ? openThread() : null;

  const reset = () => {
    setNote("");
    setScreenshot(undefined);
    setStatus(null);
  };

  const snap = async () => {
    // Out of the way of the picture, then back.
    setCapturing(true);
    setStatus(null);
    try {
      await new Promise((r) => setTimeout(r, 250));
      const { captureScreenshot } = await import("@/lib/bug-report");
      setScreenshot(await captureScreenshot());
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "NotAllowedError")) setStatus(`Couldn't take a screenshot: ${errorMessage(e)}`);
    } finally {
      setCapturing(false);
    }
  };

  const collect = async (): Promise<File> => {
    const { collectBugReport } = await import("@/lib/bug-report");
    const report = await collectBugReport(devices, entries, { note: note.trim(), threadMessages, screenshot });
    return new File([JSON.stringify(report, null, 2)], fileName(), { type: "application/json" });
  };

  const run = async (what: "download" | "copy" | "attach") => {
    setBusy(true);
    setStatus("Collecting…");
    try {
      const file = await collect();
      if (what === "download") {
        const url = URL.createObjectURL(file);
        const a = document.createElement("a");
        a.href = url;
        a.download = file.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        setStatus(`Saved ${file.name}.`);
      } else if (what === "copy") {
        await navigator.clipboard.writeText(await file.text());
        setStatus("Copied to the clipboard.");
      } else {
        const id = openThread();
        const sent = !!id && sendToComposer(id, { text: note.trim() ? `Bug: ${note.trim()}` : "", files: [file] });
        if (!sent) throw new Error("this thread has no message box open");
        setOpen(false);
        reset();
        return;
      }
    } catch (e) {
      setStatus(`Couldn't make the report: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Report a bug"
        title="Report a bug"
        className="fixed top-1.5 right-1.5 z-30 flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <BugIcon className="size-4" />
      </button>
      <Dialog open={open && !capturing} onOpenChange={(o) => setOpen(o)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Report a bug</DialogTitle>
            <DialogDescription>
              Collects what the app, its connections and your devices were doing: browser details, each device's connection
              and recent daemon log, this page's console{thread && threadMessages ? ", and this thread's recent messages" : ""}.
              It stays on this computer until you share it, so look it over first.
            </DialogDescription>
          </DialogHeader>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What happened, and what did you expect?"
            rows={4}
            className="w-full resize-none rounded-md border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          />
          {thread && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={threadMessages} onChange={(e) => setThreadMessages(e.target.checked)} />
              Include this thread's recent messages
            </label>
          )}
          {screenshot ? (
            <div className="relative">
              <img src={screenshot} alt="Screenshot for the report" className="max-h-40 w-full rounded-md border border-border object-contain" />
              <Button
                variant="secondary"
                size="icon-sm"
                className="absolute top-1 right-1"
                onClick={() => setScreenshot(undefined)}
                aria-label="Remove the screenshot"
              >
                <XIcon />
              </Button>
            </div>
          ) : (
            typeof navigator.mediaDevices?.getDisplayMedia === "function" && (
              <Button variant="outline" size="sm" className="self-start" onClick={() => void snap()}>
                <CameraIcon /> Add a screenshot
              </Button>
            )
          )}
          {desktop?.devTools && (
            <Button variant="outline" size="sm" className="self-start" onClick={() => desktop?.devTools?.()}>
              <SquareTerminalIcon /> Open developer tools
              <span className="text-xs text-muted-foreground">F12</span>
            </Button>
          )}
          {status && <p className="text-xs text-muted-foreground">{status}</p>}
          <DialogFooter>
            {thread && (
              <Button variant="outline" disabled={busy} onClick={() => void run("attach")}>
                Attach to this thread
              </Button>
            )}
            <Button variant="outline" disabled={busy} onClick={() => void run("copy")}>
              Copy
            </Button>
            <Button disabled={busy} onClick={() => void run("download")}>
              {busy && <LoaderCircleIcon className="animate-spin" />} Download
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
