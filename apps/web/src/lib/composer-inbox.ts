// Lets other panels of a thread (like the browser's annotations) hand text
// and files to that thread's composer.

export interface ComposerDraft {
  text: string;
  files: File[];
}

type Listener = (d: ComposerDraft) => void;

const listeners = new Map<string, Set<Listener>>();

/** Adds to threadId's composer; false if no composer is open for it. */
export function sendToComposer(threadId: string, draft: ComposerDraft): boolean {
  const ls = listeners.get(threadId);
  if (!ls?.size) return false;
  for (const l of ls) l(draft);
  return true;
}

export function listenComposer(threadId: string, l: Listener): () => void {
  let ls = listeners.get(threadId);
  if (!ls) listeners.set(threadId, (ls = new Set()));
  ls.add(l);
  return () => {
    ls.delete(l);
    if (!ls.size) listeners.delete(threadId);
  };
}
