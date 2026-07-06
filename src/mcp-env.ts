// Worker Env binding for the Vivijure Studio MCP Worker (src/mcp.ts).
//
// This is a SEPARATE Worker from the studio core (its own script + host, wrangler.mcp.toml). It is a
// thin MCP-to-HTTP proxy: it holds NO studio bindings (no D1, no R2, no modules). It reaches the
// studio purely over HTTP with the operator's studio bearer, so an operator can run it against any
// studio (their own self-hosted instance or a remote one) by pointing STUDIO_URL at it.
//
// Adding a var/secret: update wrangler.mcp.toml.example, then mirror it here.

export interface McpEnv {
  // The studio base URL the MCP proxies to, e.g. "https://vivijure.skyphusion.org". A [vars] entry
  // (not a secret): it is a public hostname. No trailing slash is required; the proxy normalizes it.
  STUDIO_URL?: string;

  // The studio bearer (vivijure #423 token-mode STUDIO_API_TOKEN). Sent as `Authorization: Bearer`
  // on every proxied studio call. A worker SECRET, seeded out-of-band
  // (wrangler secret put STUDIO_API_TOKEN -c wrangler.mcp.toml); never a var, never in CI. When
  // unset the Worker refuses every /mcp request (fail closed) rather than call the studio unauthed.
  STUDIO_API_TOKEN?: string;

  // The MCP gate. Every /mcp request must present `Authorization: Bearer <MCP_TOKEN>`. A worker
  // SECRET. When unset the Worker refuses all requests (fail closed). Machine-to-machine only:
  // this is a DISTINCT credential from STUDIO_API_TOKEN so an MCP client never learns the studio
  // bearer, and the two can be rotated independently.
  MCP_TOKEN?: string;
}
