import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: resolve(import.meta.dirname, "wrangler.jsonc"),
      },
      miniflare: {
        bindings: {
          API_BEARER_KEY: "vitest-api-key",
        },
      },
    }),
  ],
  test: {
    include: ["apps/api/test/**/*.spec.ts"],
  },
});
