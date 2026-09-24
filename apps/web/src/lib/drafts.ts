// Unsent composer text per thread, so a draft survives switching threads
// or tabs and reloading the page. Kept in this browser only.

const memory = new Map<string, string>();
const storageKey = (threadId: string) => `ew.draft.${threadId}`;

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
  try {
    if (text) localStorage.setItem(storageKey(threadId), text);
    else localStorage.removeItem(storageKey(threadId));
  } catch {
    // Storage full or blocked: the draft still lives until the page closes.
  }
}
