// What the agent did, as the conversation shows it: one short line per tool
// call ("Read fix flaky test", "Sent to api migration"), past tense, from the
// call's name and arguments. No browser state, so it's tested on its own.

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** A tool call in a few words. name: turns a thread reference (id or name) into its name. */
export function stepText(tool: string, args: Record<string, unknown>, name: (ref: string) => string = (r) => r): string {
  const thread = str(args.thread) ? name(str(args.thread)) : "";
  switch (tool) {
    case "list_threads":
      return str(args.project) ? `Listed threads in ${str(args.project)}` : "Listed threads";
    case "read_thread":
      return `Read ${thread || "a thread"}${typeof args.page === "number" && args.page > 1 ? ` (page ${args.page})` : ""}`;
    case "search_threads":
      return `Searched threads for "${str(args.query)}"`;
    case "thread_processes":
      return `Checked processes in ${thread || "a thread"}`;
    case "git_status":
      return `Checked git in ${thread || str(args.project) || "a project"}`;
    case "send_to_thread":
      return `Sent to ${thread || "a thread"}`;
    case "start_thread":
      return `Started a thread in ${str(args.project) || "a project"}`;
    case "open_thread":
      return `Opened ${thread || "a thread"}`;
    case "watch_thread":
      return `Watching ${thread || "a thread"}`;
    default:
      return tool.replace(/_/g, " ");
  }
}

/** What a step sent, to show under it: a send's text or a new thread's prompt. */
export function stepDetail(tool: string, args: Record<string, unknown>): string | undefined {
  if (tool === "send_to_thread") return str(args.text) || undefined;
  if (tool === "start_thread") return str(args.prompt) || undefined;
  return undefined;
}

/** Waiting this long on the model's first words counts as slow, and says so. */
export const SLOW_SECONDS = 15;

/**
 * Where a turn is, in a few words, for the status line: waiting on the model
 * (the request is out to Workers AI), thinking, writing, or the tool it's
 * running. seconds: how long it's been there. null when nothing's running,
 * or while the reply itself is streaming (it shows as it's written).
 */
export function turnStatus(
  live: { text: string; phase?: string; activity?: string; model?: string } | null,
  running: boolean,
  seconds: number,
): { label: string; slow: boolean } | null {
  if (!running && !live) return null;
  const time = seconds >= 2 ? ` · ${seconds}s` : "";
  const model = live?.model ?? "the model";
  switch (live?.phase) {
    case undefined:
      return { label: "Starting…", slow: false };
    case "waiting": {
      const slow = seconds >= SLOW_SECONDS;
      return { label: `${slow ? "Still waiting on" : "Waiting on"} ${model}${slow ? " (Workers AI)" : ""}…${time}`, slow };
    }
    case "thinking":
      return { label: `Thinking…${time}`, slow: false };
    case "writing":
      return live.text ? null : { label: `Writing…${time}`, slow: false };
    case "tool":
      return { label: `${live.activity ?? "Working"}…${time}`, slow: false };
    default:
      return null;
  }
}
