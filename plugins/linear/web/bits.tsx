import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { State } from "./types";

/** A status as Linear draws it: a ring, half full when started, a check when done. */
export function StateIcon({ state, size = 14 }: { state: State; size?: number }) {
  const c = state.color;
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" className="shrink-0" aria-label={state.name}>
      {state.type === "completed" ? (
        <>
          <circle cx="7" cy="7" r="6" fill={c} />
          <path d="M4.2 7.2 6.1 9 9.8 5.2" stroke="var(--background, #fff)" strokeWidth="1.5" fill="none" />
        </>
      ) : state.type === "canceled" ? (
        <>
          <circle cx="7" cy="7" r="6" fill={c} />
          <path d="M5 5l4 4M9 5l-4 4" stroke="var(--background, #fff)" strokeWidth="1.5" />
        </>
      ) : (
        <>
          <circle
            cx="7"
            cy="7"
            r="5.5"
            fill="none"
            stroke={c}
            strokeWidth="1.5"
            strokeDasharray={state.type === "backlog" || state.type === "triage" ? "2 1.6" : undefined}
          />
          {state.type === "started" && <path d="M7 3.5a3.5 3.5 0 0 1 0 7z" fill={c} />}
        </>
      )}
    </svg>
  );
}

/** Priority: bars, or a ! for urgent. */
export function PriorityIcon({ priority, label }: { priority: number; label: string }) {
  if (priority === 0) return <span className="w-3.5 shrink-0 text-center text-muted-foreground" title={label}>–</span>;
  if (priority === 1)
    return (
      <span className="flex size-3.5 shrink-0 items-center justify-center rounded-[3px] bg-warn text-[10px] font-bold leading-none text-background" title={label}>
        !
      </span>
    );
  const filled = 5 - priority; // high 3, medium 2, low 1
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" className="shrink-0" aria-label={label}>
      {[0, 1, 2].map((i) => (
        <rect key={i} x={2 + i * 4} y={9 - i * 3} width="2.5" height={3 + i * 3} rx="0.6" fill="currentColor" opacity={i < filled ? 1 : 0.25} />
      ))}
    </svg>
  );
}

export function Initials({ name }: { name: string }) {
  const parts = name.trim().split(/\s+/);
  const text = ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
  return (
    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[9px] font-medium text-muted-foreground" title={name}>
      {text || "?"}
    </span>
  );
}

export function LabelChip({ name, color }: { name: string; color: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[11px] text-muted-foreground">
      <span className="size-1.5 rounded-full" style={{ background: color }} />
      {name}
    </span>
  );
}

export function Button(props: ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  const { primary, className, ...rest } = props;
  return (
    <button
      {...rest}
      className={
        "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors disabled:opacity-50 " +
        (primary ? "bg-primary text-primary-foreground hover:opacity-90 " : "border hover:bg-muted ") +
        (className ?? "")
      }
    />
  );
}

/**
 * Markdown, plainly: paragraphs, headings, lists, code blocks and links
 * (opened in a new browser tab). Images are links, since the frame can't load them.
 */
export function Markdown({ text, openUrl }: { text: string; openUrl: (url: string) => void }) {
  const blocks = ("\n" + text.replace(/\r/g, "")).split(/\n```/);
  return (
    <div className="space-y-2 text-[13px] leading-relaxed">
      {blocks.map((block, i) => {
        if (i % 2 === 1) {
          const code = block.replace(/^[^\n]*\n/, "").replace(/```\s*$/, "");
          return (
            <pre key={i} className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">
              {code}
            </pre>
          );
        }
        return block
          .split(/\n{2,}/)
          .filter((p) => p.trim())
          .map((p, j) => {
            const h = /^(#{1,6})\s+(.*)$/.exec(p.trim());
            if (h)
              return (
                <p key={`${i}-${j}`} className="font-semibold">
                  <Inline text={h[2]} openUrl={openUrl} />
                </p>
              );
            const lines = p.split("\n");
            if (lines.every((l) => /^\s*([-*+]|\d+\.)\s/.test(l) || !l.trim()))
              return (
                <ul key={`${i}-${j}`} className="space-y-0.5 pl-1">
                  {lines
                    .filter((l) => l.trim())
                    .map((l, k) => {
                      const m = /^(\s*)([-*+]|\d+\.)\s+(\[[ xX]\]\s+)?(.*)$/.exec(l)!;
                      const bullet = m[3] ? (m[3].includes(" ]") ? "☐" : "☑") : /\d/.test(m[2]) ? m[2] : "•";
                      return (
                        <li key={k} className="flex gap-2" style={{ paddingLeft: m[1].length * 6 }}>
                          <span className="shrink-0 text-muted-foreground">{bullet}</span>
                          <span>
                            <Inline text={m[4]} openUrl={openUrl} />
                          </span>
                        </li>
                      );
                    })}
                </ul>
              );
            if (lines.every((l) => l.startsWith(">")))
              return (
                <blockquote key={`${i}-${j}`} className="border-l-2 pl-3 text-muted-foreground">
                  <Inline text={lines.map((l) => l.replace(/^>\s?/, "")).join("\n")} openUrl={openUrl} />
                </blockquote>
              );
            return (
              <p key={`${i}-${j}`} className="whitespace-pre-wrap">
                <Inline text={p} openUrl={openUrl} />
              </p>
            );
          });
      })}
    </div>
  );
}

const INLINE = /(!?\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|(https?:\/\/[^\s)]+))/g;

function Inline({ text, openUrl }: { text: string; openUrl: (url: string) => void }) {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const url = m[3] ?? m[6];
    if (url) {
      const label = m[3] ? m[2] || (m[1].startsWith("!") ? "image" : url) : url;
      out.push(
        <a
          key={m.index}
          href={url}
          className="text-primary underline underline-offset-2"
          onClick={(e) => {
            e.preventDefault();
            openUrl(url);
          }}
        >
          {m[1]?.startsWith("!") ? `🖼 ${label}` : label}
        </a>,
      );
    } else if (m[4]) {
      out.push(
        <code key={m.index} className="rounded bg-muted px-1 font-mono text-[12px]">
          {m[4]}
        </code>,
      );
    } else if (m[5]) {
      out.push(<strong key={m.index}>{m[5]}</strong>);
    }
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}
