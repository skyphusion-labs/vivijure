import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../src/mcp";
import type { McpEnv } from "../src/mcp-env";

const ENV: McpEnv = {
  STUDIO_URL: "https://studio.example.com",
  STUDIO_API_TOKEN: "studio-secret",
  MCP_TOKEN: "gate-secret",
};

function mcpRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://studio-mcp.example.com/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const AUTH = { Authorization: `Bearer ${ENV.MCP_TOKEN}` };

// A fetch stub that records the outgoing studio call and returns a canned JSON reply.
let calls: { url: string; init: RequestInit }[] = [];
function stubFetch(reply: unknown, status = 200, contentType = "application/json") {
  calls = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(typeof reply === "string" ? reply : JSON.stringify(reply), {
      status,
      headers: { "content-type": contentType },
    });
  }) as unknown as typeof fetch;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("vivijure MCP transport", () => {
  it("serves /health without auth", async () => {
    const res = await worker.fetch(new Request("https://x/health"), ENV);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "vivijure-studio-mcp" });
  });

  it("fails closed with no bearer (401)", async () => {
    const res = await worker.fetch(mcpRequest({ jsonrpc: "2.0", id: 1, method: "ping" }), ENV);
    expect(res.status).toBe(401);
  });

  it("fails closed when MCP_TOKEN is unset even with a bearer", async () => {
    const res = await worker.fetch(
      mcpRequest({ jsonrpc: "2.0", id: 1, method: "ping" }, AUTH),
      { ...ENV, MCP_TOKEN: undefined },
    );
    expect(res.status).toBe(401);
  });

  it("lists the curated tools + escape hatch", async () => {
    const res = await worker.fetch(
      mcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" }, AUTH),
      ENV,
    );
    const body = (await res.json()) as { result: { tools: { name: string }[] } };
    const names = body.result.tools.map((t) => t.name);
    expect(names).toContain("studio_modules");
    expect(names).toContain("submit_film");
    expect(names).toContain("poll_film");
    expect(names).toContain("studio_request");
  });

  it("initialize echoes server info", async () => {
    const res = await worker.fetch(
      mcpRequest({ jsonrpc: "2.0", id: 3, method: "initialize", params: {} }, AUTH),
      ENV,
    );
    const body = (await res.json()) as { result: { serverInfo: { name: string } } };
    expect(body.result.serverInfo.name).toBe("vivijure-studio");
  });

  it("a notification (no id) returns 202 with no body", async () => {
    const res = await worker.fetch(
      mcpRequest({ jsonrpc: "2.0", method: "initialized" }, AUTH),
      ENV,
    );
    expect(res.status).toBe(202);
  });
});

describe("vivijure MCP tool dispatch", () => {
  beforeEach(() => stubFetch({ film_id: "film-abc", phase: "keyframe" }, 201));

  it("submit_film hits /api/render/film with the studio bearer + JSON body", async () => {
    const res = await worker.fetch(
      mcpRequest(
        {
          jsonrpc: "2.0",
          id: 10,
          method: "tools/call",
          params: {
            name: "submit_film",
            arguments: {
              bundle_key: "bundles/x.tar",
              scenes: [{ shot_id: "s1", prompt: "a wide shot", seconds: 4 }],
              motion_backend: "own-gpu",
            },
          },
        },
        AUTH,
      ),
      ENV,
    );
    const body = (await res.json()) as { result: { isError: boolean; content: { text: string }[] } };
    expect(body.result.isError).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://studio.example.com/api/render/film");
    expect(calls[0].init.method).toBe("POST");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer studio-secret");
    const sent = JSON.parse(calls[0].init.body as string);
    expect(sent.bundle_key).toBe("bundles/x.tar");
    expect(sent.scenes).toHaveLength(1);
    expect(sent.motion_backend).toBe("own-gpu");
    // The film id from the studio reply is surfaced in the tool text.
    expect(body.result.content[0].text).toContain("film-abc");
  });

  it("submit_film forwards the four module-config maps verbatim in the body (#674)", async () => {
    const finish_config = { upscale: { model: "realesr-animevideov3" } };
    const speech_config = { "audio-upscale": { denoise: true } };
    const film_finish_config = { subtitle: { mode: "both" }, "film-titles": { position: "lower" } };
    const master_config = { "audio-upscale": { loudness: -14 } };
    const res = await worker.fetch(
      mcpRequest(
        {
          jsonrpc: "2.0",
          id: 20,
          method: "tools/call",
          params: {
            name: "submit_film",
            arguments: {
              bundle_key: "bundles/x.tar",
              scenes: [{ shot_id: "s1", prompt: "a wide shot", seconds: 4 }],
              finish_config,
              speech_config,
              film_finish_config,
              master_config,
            },
          },
        },
        AUTH,
      ),
      ENV,
    );
    const body = (await res.json()) as { result: { isError: boolean } };
    expect(body.result.isError).toBe(false);
    const sent = JSON.parse(calls[0].init.body as string);
    // Each map lands in the request body byte-for-byte -- the MCP layer does not reshape it, so
    // subtitle mode=both under film_finish_config actually reaches the film.finish chain (#674).
    expect(sent.finish_config).toEqual(finish_config);
    expect(sent.speech_config).toEqual(speech_config);
    expect(sent.film_finish_config).toEqual(film_finish_config);
    expect(sent.master_config).toEqual(master_config);
  });

  it("submit_film omits an unset config map (not sent as null) (#674)", async () => {
    const res = await worker.fetch(
      mcpRequest(
        {
          jsonrpc: "2.0",
          id: 21,
          method: "tools/call",
          params: {
            name: "submit_film",
            arguments: {
              bundle_key: "bundles/x.tar",
              scenes: [{ shot_id: "s1", prompt: "a wide shot", seconds: 4 }],
              film_finish_config: { subtitle: { mode: "sidecar" } },
            },
          },
        },
        AUTH,
      ),
      ENV,
    );
    const body = (await res.json()) as { result: { isError: boolean } };
    expect(body.result.isError).toBe(false);
    const sent = JSON.parse(calls[0].init.body as string);
    expect(sent.film_finish_config).toEqual({ subtitle: { mode: "sidecar" } });
    // Absent maps are dropped by bodyWithout (undefined skipped), never forwarded as null keys.
    expect("finish_config" in sent).toBe(false);
    expect("speech_config" in sent).toBe(false);
    expect("master_config" in sent).toBe(false);
  });

  it("bad arguments return an isError result and never call the studio", async () => {
    const res = await worker.fetch(
      mcpRequest(
        {
          jsonrpc: "2.0",
          id: 11,
          method: "tools/call",
          params: { name: "submit_film", arguments: { bundle_key: "k" } }, // scenes missing
        },
        AUTH,
      ),
      ENV,
    );
    const body = (await res.json()) as { result: { isError: boolean; content: { text: string }[] } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("scenes");
    expect(calls).toHaveLength(0);
  });

  it("studio_request forwards method + path + query", async () => {
    stubFetch({ renders: [] }, 200);
    await worker.fetch(
      mcpRequest(
        {
          jsonrpc: "2.0",
          id: 12,
          method: "tools/call",
          params: {
            name: "studio_request",
            arguments: { method: "get", path: "/api/storyboard/renders", query: { limit: 5 } },
          },
        },
        AUTH,
      ),
      ENV,
    );
    expect(calls[0].url).toBe("https://studio.example.com/api/storyboard/renders?limit=5");
    expect(calls[0].init.method).toBe("GET");
  });

  it("studio_request unwraps a JSON-encoded string body so the studio receives the object (#575)", async () => {
    // Schema-validating MCP clients serialize a loosely-typed arg as a JSON string; pre-#575 the
    // studio received a JSON-quoted string and every body-carrying escape-hatch call 400'd.
    stubFetch({ ok: true }, 200);
    await worker.fetch(
      mcpRequest(
        {
          jsonrpc: "2.0",
          id: 14,
          method: "tools/call",
          params: {
            name: "studio_request",
            arguments: {
              method: "POST",
              path: "/api/storyboard/score-bed",
              body: '{"kind":"music","prompt":"warm piano","seconds":36}',
            },
          },
        },
        AUTH,
      ),
      ENV,
    );
    const sent = JSON.parse(calls[0].init.body as string);
    expect(sent).toEqual({ kind: "music", prompt: "warm piano", seconds: 36 });
  });

  it("studio_request still forwards an object body verbatim", async () => {
    stubFetch({ ok: true }, 200);
    await worker.fetch(
      mcpRequest(
        {
          jsonrpc: "2.0",
          id: 15,
          method: "tools/call",
          params: {
            name: "studio_request",
            arguments: { method: "POST", path: "/api/x", body: { a: 1, nested: { b: "c" } } },
          },
        },
        AUTH,
      ),
      ENV,
    );
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ a: 1, nested: { b: "c" } });
  });

  it("studio_request rejects a non-JSON string body as a bad argument, studio never called (#575)", async () => {
    stubFetch({}, 200);
    const res = await worker.fetch(
      mcpRequest(
        {
          jsonrpc: "2.0",
          id: 16,
          method: "tools/call",
          params: {
            name: "studio_request",
            arguments: { method: "POST", path: "/api/x", body: "not json at all" },
          },
        },
        AUTH,
      ),
      ENV,
    );
    const body = (await res.json()) as { result: { isError: boolean; content: { text: string }[] } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("JSON");
    expect(calls).toHaveLength(0);
  });

  it("studio_request rejects a path without a leading slash", async () => {
    stubFetch({}, 200);
    const res = await worker.fetch(
      mcpRequest(
        {
          jsonrpc: "2.0",
          id: 13,
          method: "tools/call",
          params: { name: "studio_request", arguments: { method: "GET", path: "api/x" } },
        },
        AUTH,
      ),
      ENV,
    );
    const body = (await res.json()) as { result: { isError: boolean } };
    expect(body.result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("fails closed when STUDIO_API_TOKEN is unset", async () => {
    stubFetch({}, 200);
    const res = await worker.fetch(
      mcpRequest(
        { jsonrpc: "2.0", id: 14, method: "tools/call", params: { name: "studio_modules", arguments: {} } },
        AUTH,
      ),
      { ...ENV, STUDIO_API_TOKEN: undefined },
    );
    const body = (await res.json()) as { result: { isError: boolean; content: { text: string }[] } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("STUDIO_API_TOKEN");
    expect(calls).toHaveLength(0);
  });

  it("binary responses are summarized, not dumped", async () => {
    stubFetch("\x00\x01binary", 200, "video/mp4");
    const res = await worker.fetch(
      mcpRequest(
        {
          jsonrpc: "2.0",
          id: 15,
          method: "tools/call",
          params: { name: "studio_request", arguments: { method: "GET", path: "/api/artifact/x.mp4" } },
        },
        AUTH,
      ),
      ENV,
    );
    const body = (await res.json()) as { result: { content: { text: string }[] } };
    expect(body.result.content[0].text).toContain("Binary response");
  });
});
