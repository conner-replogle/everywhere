import type { PermissionMode } from "@everywhere/protocol";

export const PERMISSION_MODES: { value: PermissionMode; label: string; hint: string }[] = [
  { value: "default", label: "Ask before edits", hint: "Prompts for file edits and commands" },
  { value: "acceptEdits", label: "Accept edits", hint: "Edits files freely, asks before commands" },
  { value: "plan", label: "Plan", hint: "Researches and proposes a plan, changes nothing" },
  { value: "auto", label: "Auto", hint: "A classifier approves safe actions" },
  { value: "bypassPermissions", label: "Bypass permissions", hint: "Never asks. Only for sandboxes" },
];
