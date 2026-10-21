import { useEffect, useRef, useState } from "react";
import { usePlugin } from "everywhere";

// The Notes tab: a textarea saved to the device as you type, and updated
// when claude adds to it (the notes plugin keeps them in its KV).
export default function Notes() {
  const plugin = usePlugin();
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState(true);
  const timer = useRef<number>(0);

  const load = () =>
    plugin.call<{ text: string }>("notes.get", { threadId: plugin.threadId }).then((r) => setText(r.text));
  useEffect(() => void load(), []);
  plugin.useEvent((e) => {
    // Notes are kept per thread; claude adding to them changes them.
    if (e.event === "notes.kv.changed" && e.scope === `thread:${plugin.threadId}` && saved) void load();
  });

  const change = (value: string) => {
    setText(value);
    setSaved(false);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      await plugin.call("notes.set", { threadId: plugin.threadId, text: value });
      setSaved(true);
    }, 500);
  };

  if (text === null) return <p className="p-4 text-xs text-muted-foreground">Loading…</p>;
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-3 py-1.5 text-xs text-muted-foreground">
        <span>Notes for this thread — Claude can read and add to them</span>
        <span>{saved ? "Saved" : "Saving…"}</span>
      </div>
      <textarea
        className="flex-1 resize-none bg-background p-3 font-mono text-[13px] outline-none"
        value={text}
        placeholder="Decisions, todos, anything to keep…"
        onChange={(e) => change(e.target.value)}
      />
    </div>
  );
}
