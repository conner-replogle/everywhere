// What the linear plugin's methods answer (see ../linear.go).

export interface State {
  id: string;
  name: string;
  type: "triage" | "backlog" | "unstarted" | "started" | "completed" | "canceled" | string;
  color: string;
  position: number;
}

export interface User {
  id: string;
  name: string;
  displayName: string;
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  priority: number;
  priorityLabel: string;
  estimate?: number;
  branchName: string;
  updatedAt: string;
  createdAt: string;
  state: State;
  assignee: User | null;
  team: { id: string; key: string; name: string };
  project: { id: string; name: string } | null;
  labels: { nodes: { name: string; color: string }[] };
}

export interface IssueDetail extends Issue {
  description: string;
  creator: User | null;
  parent: { identifier: string; title: string } | null;
  children: { nodes: { identifier: string; title: string; state: State }[] };
  comments: { nodes: { id: string; body: string; createdAt: string; user: User | null }[] };
  states: State[];
}

export interface Link {
  type: "project" | "team";
  id: string;
  name: string;
  url?: string;
}

export interface TabState {
  issue?: string;
  mine?: boolean;
  closed?: boolean;
}

/** Workflow order: what's being worked on first. */
export const STATE_ORDER = ["started", "unstarted", "triage", "backlog", "completed", "canceled"];

export function stateRank(s: State) {
  const i = STATE_ORDER.indexOf(s.type);
  return (i < 0 ? STATE_ORDER.length : i) * 1000 + s.position;
}

export function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

export function ago(iso: string) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}
