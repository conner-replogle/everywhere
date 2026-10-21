// "Changes to this computer": the tool calls in a Scratch thread that
// changed the machine outside its folder, the thread's change trail.

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

interface ToolLike {
  kind: string;
  tool?: { name: string; input: unknown };
  result?: unknown;
  request?: { decision?: string };
  children?: ToolLike[];
}

/**
 * The tool calls among timeline items (subagents' too) that changed the
 * computer outside cwd, oldest first.
 */
export function changeItems<T extends ToolLike>(items: T[], cwd: string | undefined): T[] {
  const out: T[] = [];
  const walk = (list: T[]) => {
    for (const item of list) {
      if (item.kind !== "tool" || !item.tool) continue;
      // A call that was denied or never ran changed nothing.
      const ran = !!item.result && item.request?.decision !== "deny";
      if (ran && machineChange(item.tool.name, asInput(item.tool.input), cwd)) out.push({ ...item, children: [] });
      walk((item.children ?? []) as T[]);
    }
  };
  walk(items);
  return out;
}

type ToolInput = Record<string, unknown>;

function asInput(v: unknown): ToolInput {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as ToolInput) : {};
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
