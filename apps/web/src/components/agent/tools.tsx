// How Claude Code's tools look in the timeline: an icon, a one-line summary
// and, for file edits, a diff.

import {
  ActivityIcon,
  BotIcon,
  ClipboardListIcon,
  FilePenIcon,
  FileTextIcon,
  GlobeIcon,
  ListTodoIcon,
  type LucideIcon,
  MessageCircleQuestionIcon,
  PlugIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type ToolInput = Record<string, unknown>;

export function asInput(v: unknown): ToolInput {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as ToolInput) : {};
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

const PROCESS_TOOL = /^mcp__everywhere__process_(.+)$/;

export function toolIcon(name: string): LucideIcon {
  if (PROCESS_TOOL.test(name)) return ActivityIcon;
  if (name.startsWith("mcp__")) return PlugIcon;
  switch (name) {
    case "Bash":
      return TerminalIcon;
    case "Read":
      return FileTextIcon;
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return FilePenIcon;
    case "Grep":
    case "Glob":
      return SearchIcon;
    case "WebFetch":
    case "WebSearch":
      return GlobeIcon;
    case "Agent":
    case "Task":
      return BotIcon;
    case "TodoWrite":
      return ListTodoIcon;
    case "AskUserQuestion":
      return MessageCircleQuestionIcon;
    case "ExitPlanMode":
      return ClipboardListIcon;
  }
  return WrenchIcon;
}

/** "server · tool" for MCP tools, the plain name otherwise. */
export function toolLabel(name: string): string {
  const p = PROCESS_TOOL.exec(name);
  if (p) return `Process · ${p[1]}`;
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? `${m[1]} · ${m[2]}` : name;
}

/** Shows paths inside the project relative to it. */
export function relPath(path: string, cwd: string | undefined): string {
  if (cwd && path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1);
  return path;
}

export function toolSummary(name: string, input: ToolInput, cwd?: string): string {
  switch (name) {
    case "Bash":
      return str(input.command).split("\n")[0] ?? "";
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      return relPath(str(input.file_path), cwd);
    case "NotebookEdit":
      return relPath(str(input.notebook_path), cwd);
    case "Grep":
    case "Glob": {
      const where = str(input.path) || str(input.glob);
      return where ? `${str(input.pattern)}  in ${relPath(where, cwd)}` : str(input.pattern);
    }
    case "WebFetch":
      return str(input.url);
    case "WebSearch":
      return str(input.query);
    case "Agent":
    case "Task":
      return str(input.description) || str(input.subagent_type);
    case "TodoWrite":
      return Array.isArray(input.todos) ? `${input.todos.length} items` : "";
    case "AskUserQuestion": {
      const q = Array.isArray(input.questions) ? asInput(input.questions[0]) : {};
      return str(q.question);
    }
    case "ExitPlanMode":
      return "Proposed plan";
    case "mcp__everywhere__process_start": {
      const what = str(input.command).split("\n")[0] || "tracker";
      return `${str(input.name)}  ${what}`;
    }
  }
  const first = Object.values(input).find((v) => typeof v === "string");
  return typeof first === "string" ? first : "";
}

// --- diffs ---------------------------------------------------------------------

type DiffLine = { op: " " | "-" | "+"; text: string };

/** Line diff by longest common subsequence; big inputs fall back to all-removed/all-added. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  if (a.length * b.length > 250_000) {
    return [...a.map((text) => ({ op: "-" as const, text })), ...b.map((text) => ({ op: "+" as const, text }))];
  }
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: " ", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ op: "-", text: a[i++]! });
    else out.push({ op: "+", text: b[j++]! });
  }
  while (i < a.length) out.push({ op: "-", text: a[i++]! });
  while (j < b.length) out.push({ op: "+", text: b[j++]! });
  return out;
}

export function Diff({ before, after, className }: { before: string; after: string; className?: string }) {
  const lines = lineDiff(before, after);
  return (
    <pre className={cn("overflow-x-auto rounded-md border bg-terminal py-2 font-mono text-xs leading-relaxed", className)}>
      {lines.map((l, i) => (
        <div
          key={i}
          className={cn(
            "px-3 whitespace-pre",
            l.op === "-" && "bg-destructive/10 text-destructive",
            l.op === "+" && "bg-live/10 text-live",
          )}
        >
          <span className="mr-2 select-none opacity-60">{l.op}</span>
          {l.text}
        </div>
      ))}
    </pre>
  );
}

/** The file change a Write/Edit/MultiEdit call makes, if it is one. */
export function EditPreview({ name, input, className }: { name: string; input: ToolInput; className?: string }) {
  switch (name) {
    case "Edit":
      return <Diff before={str(input.old_string)} after={str(input.new_string)} className={className} />;
    case "MultiEdit":
      return (
        <div className={cn("grid gap-2", className)}>
          {(Array.isArray(input.edits) ? input.edits : []).map((e, i) => {
            const edit = asInput(e);
            return <Diff key={i} before={str(edit.old_string)} after={str(edit.new_string)} />;
          })}
        </div>
      );
    case "Write":
      return <Diff before="" after={str(input.content)} className={className} />;
  }
  return null;
}

export function isEdit(name: string): boolean {
  return name === "Edit" || name === "MultiEdit" || name === "Write";
}

const FILE_EDITS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const SCREEN_ACTIONS = /^mcp__everywhere__desktop_(click|drag|type|press|scroll|launch|open|clipboard|move|focus)$/;
// Commands that change the computer rather than look at it: services,
// packages, settings, deleting and moving files, processes, power.
const MUTATING = [
  /\b(systemctl|service)\s+(--user\s+)?(start|stop|restart|reload|enable|disable|mask|unmask|kill|daemon-reload|set-property|edit)\b/,
  /\b(apt|apt-get|dnf|yum|zypper|apk|snap|flatpak|brew|port)\s+(-\S+\s+)*(install|remove|purge|uninstall|upgrade|update|autoremove|reinstall)\b/,
  /\b(pacman|yay|paru)\s+-[A-Za-z]*[SRUD]/,
  /\b(winget|choco|scoop)\s+(install|uninstall|upgrade|remove)\b/,
  /\b(pip3?|pipx|npm|pnpm|bun|cargo|go)\s+(install|uninstall|remove|add)\b.*(-g\b|--global\b|--user\b)?/,
  /(^|[\s;&|(])(sudo\s+)?(rm|rmdir|mv|chmod|chown|chgrp|ln|truncate|shred|dd|mkfs\S*|mount|umount|kill|killall|pkill|reboot|shutdown|poweroff|crontab|useradd|userdel|usermod|passwd)\s/,
  /\bsed\s+(-\S+\s+)*-i/,
  /\b(gsettings\s+set|dconf\s+(write|reset)|defaults\s+write|hyprctl\s+(keyword|dispatch|reload)|nmcli\s+\S+\s+(up|down|modify|delete|add|connect)|rfkill\s+(block|unblock)|timedatectl\s+set|hostnamectl\s+set|localectl\s+set)\b/,
  /\b(Remove-Item|Move-Item|Set-ItemProperty|New-ItemProperty|Stop-Service|Start-Service|Restart-Service|Set-Service|Stop-Process|Restart-Computer|Stop-Computer|Set-ExecutionPolicy)\b/i,
  /\breg(\.exe)?\s+(add|delete|import)\b/i,
  /\bgit\s+(push|reset\s+--hard|clean\s+-\S*f|checkout\s+--)/,
];

/**
 * Why a tool call changed the computer outside the thread's folder (cwd),
 * or null if it only looked, or kept to the folder: edits to files
 * elsewhere, commands that change the system, using the screen.
 */
export function machineChange(name: string, input: ToolInput, cwd?: string): string | null {
  if (FILE_EDITS.has(name)) {
    const path = str(input.file_path) || str(input.notebook_path);
    if (!path || (cwd && (path === cwd || path.startsWith(`${cwd}/`)))) return null;
    return `Changed ${path}`;
  }
  if (name === "Bash") {
    const command = str(input.command);
    return MUTATING.some((re) => re.test(command)) ? "Ran a command that changes the system" : null;
  }
  if (SCREEN_ACTIONS.test(name)) return "Used the screen";
  return null;
}
