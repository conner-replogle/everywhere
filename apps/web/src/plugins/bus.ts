// A thread page's event bus: how plugins tell each other things (claude
// used the browser; show this process) without importing each other.

import type { ThreadEvent, ThreadEvents } from "./types";

export interface ThreadBus {
  emit<E extends ThreadEvent>(event: E, payload: ThreadEvents[E]): void;
  on<E extends ThreadEvent>(event: E, fn: (payload: ThreadEvents[E]) => void): () => void;
}

export function createThreadBus(): ThreadBus {
  const listeners = new Map<ThreadEvent, Set<(payload: never) => void>>();
  return {
    emit(event, payload) {
      for (const fn of [...(listeners.get(event) ?? [])]) {
        try {
          (fn as (p: typeof payload) => void)(payload);
        } catch (e) {
          // One plugin's handler failing doesn't stop the others.
          console.error(`plugin handler for ${event} failed`, e);
        }
      }
    },
    on(event, fn) {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(fn as (payload: never) => void);
      return () => set.delete(fn as (payload: never) => void);
    },
  };
}
