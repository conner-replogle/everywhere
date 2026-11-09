// The Worker's plugins, built in. Their daemon and web parts are the plugins
// of the same names on devices and in the app.

import { Hono } from "hono";
import { serveDashboardFrame } from "../dashboard";
import { github as githubRoutes } from "../routes/github";
import { prompt } from "../routes/prompt";
import { speech } from "../routes/speech";
import type { App } from "../types";
import { agentSettings } from "../agents/keys";
import { mcp } from "../agents/mcp";
import { claude } from "./claude";
import { pluginSettings } from "./plugin-settings";
import { push } from "./push";
import type { WorkerPlugin } from "./types";

const dashboardFrame = new Hono<App>();
dashboardFrame.get("/", serveDashboardFrame);

export const WORKER_PLUGINS: readonly WorkerPlugin[] = [
  claude,
  push,
  pluginSettings,
  // Connecting a GitHub account; cloning with its token goes through the hub to the clone plugin.
  { id: "github", routes: [{ path: "/api/github", app: githubRoutes }] },
  // Dictation and prompt rewrites in the composer, on Workers AI.
  { id: "speech", routes: [{ path: "/api/speech", app: speech }] },
  { id: "rewrite", routes: [{ path: "/api/prompt", app: prompt }] },
  // Connected agents: the MCP endpoint and its keys (off until the user turns it on).
  { id: "agents", routes: [{ path: "/", app: mcp }, { path: "/api/agents", app: agentSettings }] },
  // The sandboxed frame dashboards (and external plugins' web parts) run in.
  { id: "dashboards", routes: [{ path: "/dashboard", app: dashboardFrame }] },
];
