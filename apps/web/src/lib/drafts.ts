// Unsent composer text per thread, so a draft survives switching threads
// or tabs and reloading the page. Kept in this browser only.

const memory = new Map<string, string>();
const dirty = new Map<string, string>();
const storageKey = (threadId: string) => `ew.draft.${threadId}`;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function flushDrafts(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (dirty.size === 0) return;
  const entries = [...dirty.entries()];
  dirty.clear();
  for (const [threadId, text] of entries) {
    try {
      if (text) localStorage.setItem(storageKey(threadId), text);
      else localStorage.removeItem(storageKey(threadId));
    } catch {
      // Storage full or blocked: the draft still lives until the page closes.
    }
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushDrafts);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushDrafts();
  });
}

export function loadDraft(threadId: string): string {
  const d = memory.get(threadId);
  if (d !== undefined) return d;
  try {
    return localStorage.getItem(storageKey(threadId)) ?? "";
  } catch {
    return "";
  }
}

export function saveDraft(threadId: string, text: string): void {
  memory.set(threadId, text);
  dirty.set(threadId, text);
  if (flushTimer === null) {
    flushTimer = setTimeout(flushDrafts, 300);
  }
}
