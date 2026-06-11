import { defineConfig } from "vitest/config";

// Plain Vitest in a Node environment: the registry's pure helpers (manifest + config validation,
// hook indexing, the response shape) test without the Workers runtime. Discovery is exercised with
// fake fetcher bindings. No @cloudflare/vitest-pool-workers needed at this layer.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
