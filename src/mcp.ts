// Vivijure Studio MCP Worker.
//
// A minimal, stateless Streamable-HTTP MCP server that lets an AI agent drive the Vivijure Studio
// API (docs/CONTRACT.md) through structured tools instead of raw curl/playwright. It is a SEPARATE
// Worker from the studio core (its own script + host, wrangler.mcp.toml); it holds NO studio
// bindings and reaches the studio purely over HTTP with the operator's studio bearer, so it can run
// against any studio by pointing STUDIO_URL at it.
//
// Two independent credentials keep the surfaces clean:
//   - MCP_TOKEN         gates THIS server (every /mcp request needs Authorization: Bearer <MCP_TOKEN>).
//   - STUDIO_API_TOKEN  is the studio bearer this server sends onward; the MCP client never sees it.
// Both are worker secrets seeded out-of-band; either unset => fail closed.
//
// Long-running renders are agent-driven: submit_film returns a job id, then the agent polls poll_film
// until done/failed. This server never long-polls or holds job state.

import type { McpEnv } from "./mcp-env";
import { TOOLS, TOOLS_BY_NAME, runTool } from "./mcp-tools";

const SERVER_INFO = { name: "vivijure-studio", version: "0.1.0" };
const PROTOCOL_VERSION = "2025-06-18";

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}
function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(status === 202 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });
}

// Public tool list: name + description + inputSchema only (no server-side build function).
const PUBLIC_TOOLS = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
}));

async function handleRpc(msg: RpcMessage, env: McpEnv): Promise<unknown> {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: (params?.protocolVersion as string | undefined) || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: PUBLIC_TOOLS });
    case "tools/call": {
      const name = params?.name as string | undefined;
      const tool = name ? TOOLS_BY_NAME.get(name) : undefined;
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${String(name)}`);
      const args = (params?.arguments as Record<string, unknown>) || {};
      let call;
      try {
        call = tool.build(args);
      } catch (err) {
        // A bad argument is DATA, not a transport error: return it as an isError tool result so the
        // agent can correct itself rather than see a JSON-RPC failure.
        return rpcResult(id, {
          content: [{ type: "text", text: `Invalid arguments for ${name}: ${String(err)}` }],
          isError: true,
        });
      }
      const result = await runTool(env, call);
      return rpcResult(id, result);
    }
    default:
      return rpcError(id, -32601, `Method not found: ${String(method)}`);
  }
}

export default {
  async fetch(request: Request, env: McpEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return json({ ok: true, service: "vivijure-studio-mcp" });
    }
    if (url.pathname !== "/mcp") return json({ error: "not_found" }, 404);

    // Bearer gate, fail closed. Machine-to-machine only.
    const auth = request.headers.get("Authorization") ?? "";
    if (!env.MCP_TOKEN || auth !== `Bearer ${env.MCP_TOKEN}`) {
      return json({ error: "unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });
    }

    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { Allow: "POST" } });
    }

    let payload: RpcMessage | RpcMessage[];
    try {
      payload = (await request.json()) as RpcMessage | RpcMessage[];
    } catch {
      return json(rpcError(null, -32700, "Parse error"));
    }

    const hasId = (m: RpcMessage) => m.id !== undefined && m.id !== null;

    if (Array.isArray(payload)) {
      const responses: unknown[] = [];
      for (const m of payload) {
        if (hasId(m)) responses.push(await handleRpc(m, env));
      }
      return responses.length ? json(responses) : json(null, 202);
    }

    // Notifications (no id) get no body, just 202 Accepted.
    if (!hasId(payload)) return json(null, 202);

    return json(await handleRpc(payload, env));
  },
} satisfies ExportedHandler<McpEnv>;
