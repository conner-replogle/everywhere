// Connected agents' MCP endpoint (Streamable HTTP, stateless JSON responses).
// Callers authenticate with an API key from Settings → Connected agents
// (`Authorization: Bearer ewk_…`); a key sees only the tools its scopes allow
// and reaches only its devices. While connected agents are off, /mcp is 404.
import { Hono } from "hono";
import type { Context } from "hono";
import type { App } from "../types";
import { agentsOn, bearerAgent, logActivity } from "./keys";
import { type Content, ToolError, type ToolContext, tools } from "./tools";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_VERSION = "2.0.0";

const INSTRUCTIONS = `everywhere runs Claude Code conversations ("threads") and terminals on the user's machines ("devices"). Each device has projects (folders) and Scratch (a fresh folder per thread, for work outside a project).
- Find things with list_threads, search_threads and list_projects. Threads are found by id on any device this key reaches; device is optional where the tool says so.
- read_thread reads a conversation in pages: newest first, then before=<cursor> for older ones; after=<cursor> with wait_seconds follows a thread while Claude works.
- create_thread starts a Claude thread (with a first prompt and files) and send_message prompts one; both wait for the reply. Files go in attachments (text, base64 or an https URL); files in threads come back with get_attachment.
- Claude works under its thread's permission mode and asks the user, not you, before anything else. When a thread is waiting on the user, tell them; you can't answer for them.
- You can't run commands, read other files or type into terminals. To get something done on a device, ask a Claude thread to do it.
- Give the user the thread's link when they may want to look.`;

export const mcp = new Hono<App>();

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id",
  "access-control-expose-headers": "mcp-session-id",
  "access-control-max-age": "86400",
};

function headers(c: Context<App>) {
  for (const [k, v] of Object.entries(CORS)) c.header(k, v);
  c.header("cache-control", "no-store");
  c.header("x-content-type-options", "nosniff");
}

// None of it exists while connected agents are off.
mcp.use("/mcp", async (c, next) => {
  if (!(await agentsOn(c.env))) return c.json({ error: "not found" }, 404);
  await next();
});

mcp.options("/mcp", (c) => (headers(c), c.body(null, 204)));

// No server-initiated streams or sessions: only POST.
mcp.on(["GET", "DELETE"], "/mcp", (c) => {
  headers(c);
  c.header("allow", "POST, OPTIONS");
  return c.body(null, 405);
});

mcp.post("/mcp", async (c) => {
  headers(c);
  const who = await bearerAgent(c);
  if (!who) {
    return c.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "unauthorized: use an API key from Settings → Connected agents" } }, 401);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400);
  }
  const batch = Array.isArray(body);
  const messages = (batch ? body : [body]) as JsonRpcMessage[];
  if (messages.length > 20) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "batch too large" } }, 400);
  const replies = (
    await Promise.all(
      messages.map((m) => handle(c, { env: c.env, who, touched: {} }, m)),
    )
  ).filter((r) => r !== null);
  // Only notifications or responses: nothing to answer.
  if (replies.length === 0) return c.body(null, 202);
  return c.json(batch ? replies : replies[0]);
});

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function allowed(ctx: ToolContext) {
  return tools.filter((t) => ctx.who.scopes.includes(t.scope));
}

async function handle(c: Context<App>, ctx: ToolContext, msg: JsonRpcMessage): Promise<object | null> {
  if (!msg || typeof msg !== "object" || typeof msg.method !== "string") {
    // A response to something we sent (we send nothing), or garbage.
    return msg && typeof msg === "object" && "id" in msg && !("result" in msg || "error" in msg)
      ? { jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32600, message: "invalid request" } }
      : null;
  }
  if (msg.id === undefined || msg.id === null) return null; // a notification
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  const error = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id, error: { code, message } });

  switch (msg.method) {
    case "initialize": {
      const requested = msg.params?.protocolVersion;
      return reply({
        protocolVersion: typeof requested === "string" && PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "everywhere", title: "everywhere", version: SERVER_VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({
        tools: allowed(ctx).map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { title: t.title, ...t.annotations },
        })),
      });
    case "tools/call": {
      const name = msg.params?.name;
      const tool = tools.find((t) => t.name === name);
      if (!tool) return error(-32602, `unknown tool ${String(name)}`);
      if (!ctx.who.scopes.includes(tool.scope)) {
        return reply({ content: [{ type: "text", text: `This key isn't allowed to ${tool.title.toLowerCase()}; its owner can make one that is.` }], isError: true });
      }
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      let content: Content[];
      let failed: string | undefined;
      try {
        const out = await tool.run(ctx, args && typeof args === "object" ? args : {});
        content = typeof out === "string" ? [{ type: "text", text: out }] : out;
      } catch (e) {
        failed = e instanceof ToolError ? e.message : `internal error: ${e instanceof Error ? e.message : String(e)}`;
        if (!(e instanceof ToolError)) console.error("mcp tool failed", tool.name, e);
        content = [{ type: "text", text: failed }];
      }
      c.executionCtx.waitUntil(
        logActivity(ctx.env, ctx.who, { tool: tool.name, ...ctx.touched, ok: !failed, error: failed }).catch((e) =>
          console.error("agent activity", e),
        ),
      );
      return reply(failed ? { content, isError: true } : { content });
    }
    case "resources/list":
      return reply({ resources: [] });
    case "resources/templates/list":
      return reply({ resourceTemplates: [] });
    case "prompts/list":
      return reply({ prompts: [] });
    default:
      return error(-32601, `method not found: ${msg.method}`);
  }
}
