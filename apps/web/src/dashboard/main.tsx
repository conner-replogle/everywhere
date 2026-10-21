import "@tailwindcss/browser";
import "@fontsource-variable/ibm-plex-sans";
import "@fontsource-variable/jetbrains-mono";
import * as React from "react";
import { Component, type ReactNode } from "react";
import * as ReactDOM from "react-dom";
import * as ReactDOMClient from "react-dom/client";
import * as jsxRuntime from "react/jsx-runtime";
import { api } from "./api";
import type { ToFrame } from "./bridge";
import { post, reportError, settle, store } from "./frame";

/*
 * A process's dashboard runs here: dashboard.html in a sandboxed frame (no
 * same origin, no network). The app sends the bundle the daemon built from
 * .everywhere/dashboards/<name>, which gets React and "everywhere" from
 * globalThis.__everywhere.modules, and default-exports the dashboard.
 */

// Tailwind (the browser build, so a dashboard's own classes work) with the
// app's theme, as in styles.css.
const tailwind = document.createElement("style");
tailwind.setAttribute("type", "text/tailwindcss");
tailwind.textContent = `
@custom-variant dark (&:is(.dark *));
@theme inline {
  --font-sans: "IBM Plex Sans Variable", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "JetBrains Mono Variable", ui-monospace, "SF Mono", Menlo, monospace;
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);
  --color-live: var(--live);
  --color-warn: var(--warn);
  --color-chart-1: var(--chart-1);
  --color-chart-2: var(--chart-2);
  --color-chart-3: var(--chart-3);
  --color-chart-4: var(--chart-4);
  --radius-sm: calc(0.375rem - 2px);
  --radius-md: 0.375rem;
  --radius-lg: calc(0.375rem + 2px);
  --radius-xl: calc(0.375rem + 6px);
}
@layer base {
  * { @apply border-border outline-ring/50; }
  body {
    @apply bg-background text-foreground font-sans antialiased;
    font-size: 13px;
    line-height: 1.45;
    font-feature-settings: "ss02", "tnum";
  }
}
`;
document.head.append(tailwind);

(globalThis as { __everywhere?: unknown }).__everywhere = {
  modules: {
    react: React,
    "react/jsx-runtime": jsxRuntime,
    "react/jsx-dev-runtime": jsxRuntime,
    "react-dom": ReactDOM,
    "react-dom/client": ReactDOMClient,
    everywhere: api,
  },
};

window.addEventListener("error", (e) => reportError(describe(e.error ?? e.message)));
window.addEventListener("unhandledrejection", (e) => reportError(describe(e.reason)));

function describe(err: unknown): string {
  if (err instanceof Error) {
    const where = err.stack?.split("\n").slice(1, 4).join("\n") ?? "";
    return `${err.name}: ${err.message}${where ? `\n${where}` : ""}`;
  }
  return String(err);
}

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    reportError(`${describe(error)}${info.componentStack ? `\nin${info.componentStack.split("\n").slice(0, 4).join("\n")}` : ""}`);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return <Failed message={describe(this.state.error)} />;
  }
}

function Failed({ message }: { message: string }) {
  return (
    <div className="grid gap-2 p-4 text-xs">
      <p className="font-medium text-destructive">{store.plugin ? "The plugin hit an error" : "The dashboard hit an error"}</p>
      <pre className="overflow-auto rounded-md border bg-card p-3 font-mono whitespace-pre-wrap">{message}</pre>
      {!store.plugin && (
        <p className="text-muted-foreground">Claude sees this too (dashboard_build, process_status), so it can fix it.</p>
      )}
    </div>
  );
}

const root = ReactDOMClient.createRoot(document.getElementById("root")!);
let started = false;

function start(js: string, css?: string, what = "dashboard") {
  if (started) return;
  started = true;
  if (css) {
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
  }
  const script = document.createElement("script");
  const url = URL.createObjectURL(new Blob([js], { type: "text/javascript" }));
  script.src = url;
  script.onload = () => {
    URL.revokeObjectURL(url);
    const mod = (globalThis as { __dashboard?: { default?: React.ComponentType } }).__dashboard;
    const Dashboard = mod?.default;
    if (typeof Dashboard !== "function") {
      const message =
        what === "plugin"
          ? "web/index.tsx has no default export: export default function View() { … }"
          : "index.tsx has no default export: export default function Dashboard() { … }";
      reportError(message);
      root.render(<Failed message={message} />);
      return;
    }
    root.render(
      <Boundary>
        <div className={what === "plugin" ? "h-screen" : "min-h-screen p-3"}>
          <Dashboard />
        </div>
      </Boundary>,
    );
  };
  script.onerror = () => reportError("The dashboard's script didn't load");
  document.head.append(script);
}

window.addEventListener("message", (e: MessageEvent<ToFrame>) => {
  if (e.source !== window.parent) return;
  const msg = e.data;
  switch (msg.t) {
    case "init":
      store.setTheme(msg.theme);
      store.setProcess(msg.process);
      start(msg.js, msg.css);
      break;
    case "plugin-init":
      store.setTheme(msg.theme);
      store.plugin = msg.plugin;
      start(msg.js, msg.css, "plugin");
      break;
    case "plugin-event":
      store.pluginEvent(msg.event);
      break;
    case "process":
      store.setProcess(msg.process);
      break;
    case "theme":
      store.setTheme(msg.theme);
      break;
    case "telemetry":
      store.telemetryChanged(msg.experiments);
      break;
    case "reply":
      settle(msg.id, msg.result, msg.error);
      break;
  }
});

post({ t: "ready" });
