import { SquareTerminalIcon } from "lucide-react";
import { createContext, memo, useContext } from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/**
 * Opens a terminal with a command typed in, not run, for the user to check
 * and run themselves: offered on code blocks that need root, which claude
 * can't do. Absent where there's no terminal to open.
 */
export const RunInTerminalContext = createContext<((command: string) => void) | null>(null);

type HastNode = NonNullable<ExtraProps["node"]>;

function hastText(node: HastNode | { type: string; value?: string; children?: unknown[] } | undefined): string {
  if (!node) return "";
  if (node.type === "text") return (node as { value: string }).value;
  const children = (node as { children?: unknown[] }).children ?? [];
  return children.map((c) => hastText(c as HastNode)).join("");
}

/**
 * The command a code block runs with sudo, as one line to type: shell
 * prompts and comments dropped, several commands joined with &&. Null when
 * no line uses sudo.
 */
export function sudoCommand(block: string): string | null {
  const lines = block
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.replace(/^\$\s+/, ""));
  if (!lines.some((l) => /^sudo\s/.test(l))) return null;
  // Lines continued with a backslash are one command.
  const commands: string[] = [];
  let current = "";
  for (const l of lines) {
    current = current ? `${current} ${l}` : l;
    if (current.endsWith("\\")) current = current.slice(0, -1).trimEnd();
    else {
      commands.push(current);
      current = "";
    }
  }
  if (current) commands.push(current);
  return commands.join(" && ");
}

function CodeBlock({ node, children }: { node: HastNode | undefined; children: React.ReactNode }) {
  const run = useContext(RunInTerminalContext);
  const command = run ? sudoCommand(hastText(node)) : null;
  return (
    <div className="group/code relative my-2">
      <pre className="overflow-x-auto rounded-md border bg-terminal p-3 font-mono text-xs leading-relaxed">{children}</pre>
      {command && run && (
        <button
          type="button"
          onClick={() => run(command)}
          title={`Open a terminal with this typed in, to check and run yourself:\n${command}`}
          className="mt-1 inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
        >
          <SquareTerminalIcon className="size-3.5" />
          Run in terminal
        </button>
      )}
    </div>
  );
}

// Model output renders as React elements only: raw HTML in the markdown is
// shown as text, never injected.
const components: Components = {
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer noopener" className="text-primary underline-offset-2 hover:underline">
      {children}
    </a>
  ),
  ul: ({ children }) => <ul className="my-2 list-disc space-y-0.5 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-0.5 pl-5">{children}</ol>,
  h1: ({ children }) => <h3 className="mt-4 mb-2 text-[15px] font-semibold first:mt-0">{children}</h3>,
  h2: ({ children }) => <h3 className="mt-4 mb-2 text-[14px] font-semibold first:mt-0">{children}</h3>,
  h3: ({ children }) => <h4 className="mt-3 mb-1.5 font-semibold first:mt-0">{children}</h4>,
  h4: ({ children }) => <h4 className="mt-3 mb-1.5 font-semibold first:mt-0">{children}</h4>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground">{children}</blockquote>
  ),
  hr: () => <hr className="my-3" />,
  pre: ({ children, node }) => <CodeBlock node={node}>{children}</CodeBlock>,
  code: ({ className, children }) =>
    // Fenced blocks carry a language class and sit inside <pre>, which styles them.
    className ? (
      <code className={className}>{children}</code>
    ) : (
      <code className="rounded-sm bg-secondary px-1 py-px font-mono text-[12px] [pre_&]:bg-transparent [pre_&]:p-0">
        {children}
      </code>
    ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-[12px]">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border px-2 py-1 text-left font-medium">{children}</th>,
  td: ({ children }) => <td className="border px-2 py-1 align-top">{children}</td>,
};

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("break-words", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
