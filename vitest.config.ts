import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Plain Vitest in a Node environment: the registry's pure helpers (manifest + config validation,
// hook indexing, the response shape) test without the Workers runtime. Discovery is exercised with
// fake fetcher bindings. No @cloudflare/vitest-pool-workers needed at this layer.
export default defineConfig({
  // Stub the `cloudflare:workers` runtime module so module workers that extend WorkflowEntrypoint (the
  // score modules' durable gen, #155) can be imported by the fetch-handler tests under plain node.
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(new URL("./tests/shims/cloudflare-workers.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
