// The account's MCP endpoint (Streamable HTTP, stateless JSON responses), for
// agents such as a ChatGPT connector. Tools act on every device's projects
// and threads by relaying requests through the AccountHub to the daemons.
// Callers authenticate with an OAuth access token (see oauth.ts).
import { Hono } from "hono";
import type { Context } from "hono";
import { bearerUser, resourceMetadataUrl } from "./oauth";
import { tools, ToolError, type ToolContext } from "./mcp-tools";
import type { App } from "./types";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_VERSION = "1.0.0";

const INSTRUCTIONS = `everywhere runs terminals and Claude Code conversations ("claude threads") on the user's machines ("devices").
Each device has projects (directories), and each project has threads.
- Start with list_projects or list_threads to find ids; every thread and project belongs to one device, so pass its device_id too.
- A claude thread is a Claude Code agent working in the project. send_message prompts it and waits a while for the reply; if it's still working, call read_thread with wait_seconds to keep waiting.
- When a thread's status is "waiting", it's blocked on a permission prompt or question: read_thread shows the request id; answer with respond_to_request.
- A terminal thread is a shell: send_message types a command, read_thread shows recent output.`;

export const mcp = new Hono<App>();

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id",
  "access-control-expose-headers": "www-authenticate, mcp-session-id",
  "access-control-max-age": "86400",
};

function headers(c: Context<App>) {
  for (const [k, v] of Object.entries(CORS)) c.header(k, v);
  c.header("cache-control", "no-store");
  c.header("x-content-type-options", "nosniff");
}

mcp.options("/mcp", (c) => (headers(c), c.body(null, 204)));

// No server-initiated streams or sessions: only POST.
mcp.on(["GET", "DELETE"], "/mcp", (c) => {
  headers(c);
  c.header("allow", "POST, OPTIONS");
  return c.body(null, 405);
});

mcp.post("/mcp", async (c) => {
  headers(c);
  const who = await bearerUser(c);
  if (!who) {
    c.header(
      "www-authenticate",
      `Bearer resource_metadata="${resourceMetadataUrl(c.env)}", scope="everywhere"`,
    );
    return c.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "unauthorized" } }, 401);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400);
  }
  const ctx: ToolContext = { env: c.env, accountId: who.userId };
  const batch = Array.isArray(body);
  const messages = (batch ? body : [body]) as JsonRpcMessage[];
  const replies = (await Promise.all(messages.map((m) => handle(ctx, m)))).filter((r) => r !== null);
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

async function handle(ctx: ToolContext, msg: JsonRpcMessage): Promise<object | null> {
  if (!msg || typeof msg !== "object" || typeof msg.method !== "string") {
    // A response to something we sent (we send nothing), or garbage.
    return msg && typeof msg === "object" && "id" in msg && !("result" in msg || "error" in msg)
      ? { jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32600, message: "invalid request" } }
      : null;
  }
  const isNotification = msg.id === undefined || msg.id === null;
  if (isNotification) return null;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  const error = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id, error: { code, message } });

  switch (msg.method) {
    case "initialize": {
      const requested = msg.params?.protocolVersion;
      return reply({
        protocolVersion:
          typeof requested === "string" && PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "everywhere", title: "everywhere", version: SERVER_VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({
        tools: tools.map((t) => ({
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
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const out = await tool.run(ctx, args);
        return reply({ content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out, null, 1) }] });
      } catch (e) {
        const message = e instanceof ToolError ? e.message : `internal error: ${e instanceof Error ? e.message : String(e)}`;
        if (!(e instanceof ToolError)) console.error("mcp tool failed", tool.name, e);
        return reply({ content: [{ type: "text", text: message }], isError: true });
      }
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
