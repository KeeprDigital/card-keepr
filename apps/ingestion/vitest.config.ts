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
          ADMINISTRATION_KEY: "vitest-administration-key",
        },
      },
    }),
  ],
  test: {
    include: ["apps/ingestion/test/**/*.spec.ts"],
  },
});
