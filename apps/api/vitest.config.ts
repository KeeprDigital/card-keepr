import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations(
  resolve(import.meta.dirname, "../../migrations"),
);

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: resolve(import.meta.dirname, "wrangler.jsonc"),
      },
      miniflare: {
        d1Databases: ["LEGACY_DB"],
        bindings: {
          API_BEARER_KEY: "vitest-api-key",
          API_BEARER_KEY_REPLACEMENT: "vitest-api-key-replacement-slot",
          CREDENTIAL_CONSUMER_PROOF_KEY:
            "vitest-consumer-proof-key",
          TEST_MIGRATIONS: migrations,
        },
      },
    }),
  ],
  test: {
    include: ["apps/api/test/**/*.spec.ts"],
  },
});
