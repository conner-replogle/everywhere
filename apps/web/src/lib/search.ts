// Search across every device's threads: the daemons search their own (see
// threads.search), and this merges what they found. Daemons from before the
// search index get a plainer search, and ones without any, names only.

import type { SearchHit, Thread } from "@everywhere/protocol";

/** A query's terms: "quoted phrases" and words, as the daemon reads them. */
export function searchTerms(query: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"?|(\S+)/g;
  for (const m of query.matchAll(re)) {
    const t = (m[1] ?? m[2] ?? "").trim();
    if (t) out.push(t);
    if (out.length === 16) break;
  }
  return out;
}

/** Splits text into parts that match a term and parts that don't, for highlighting. */
export function highlight(text: string, terms: string[]): { text: string; match: boolean }[] {
  const ts = terms.filter(Boolean).map((t) => t.toLowerCase());
  if (ts.length === 0 || !text) return [{ text, match: false }];
  const lower = text.toLowerCase();
  // Lowercasing changed the length (a few scripts): no highlighting rather than wrong highlighting.
  if (lower.length !== text.length) return [{ text, match: false }];
  const marked = new Array<boolean>(text.length).fill(false);
  for (const t of ts) {
    for (let i = lower.indexOf(t); i >= 0; i = lower.indexOf(t, i + t.length)) marked.fill(true, i, i + t.length);
  }
  const out: { text: string; match: boolean }[] = [];
  let start = 0;
  for (let i = 1; i <= text.length; i++) {
    if (i === text.length || marked[i] !== marked[start]) {
      out.push({ text: text.slice(start, i), match: marked[start]! });
      start = i;
    }
  }
  return out;
}

/** A hit with what the overlay shows, from whichever daemon it came. */
export interface Result {
  deviceId: string;
  hit: Required<Pick<SearchHit, "threadId" | "at" | "name" | "score">> & SearchHit;
}

/**
 * Fills in what an older daemon's hit leaves out, from its thread list, and
 * gives it a score: by recency, below a matched name (old daemons can't rank).
 */
export function completeHit(h: SearchHit, threads: Thread[] | undefined, now: number): Result["hit"] | undefined {
  const t = threads?.find((x) => x.id === h.threadId);
  const name = h.name ?? t?.name;
  if (name === undefined) return undefined;
  const days = Math.max(0, now - h.at) / 86_400_000;
  return {
    kind: t?.kind,
    projectId: t?.projectId,
    archivedAt: t?.archivedAt,
    doneAt: t?.doneAt,
    pinnedAt: t?.pinnedAt,
    role: h.snippet ? undefined : "name",
    ...h,
    name,
    score: h.score ?? 0.3 + 0.4 / (1 + days / 14),
  };
}

/** Names only, for daemons with no search at all: every term in the name (threads.list has no tabs). */
export function searchNames(threads: Thread[], query: string, now: number): SearchHit[] {
  const terms = searchTerms(query).map((t) => t.toLowerCase());
  if (terms.length === 0) return [];
  return threads
    .filter((t) => terms.every((term) => t.name.toLowerCase().includes(term)))
    .map((t) => {
      const at = Math.max(t.lastOpenedAt ?? 0, t.seenAt ?? 0, t.createdAt);
      return { threadId: t.id, at, name: t.name, role: "name" as const, score: 0.3 + 0.4 / (1 + Math.max(0, now - at) / 86_400_000 / 14) };
    });
}

/** Every device's results in one list, best first. */
export function mergeResults(results: Result[]): Result[] {
  return [...results].sort((a, b) => b.hit.score - a.hit.score || b.hit.at - a.hit.at);
}
