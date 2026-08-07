import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { resolve } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

const migrations = await readD1Migrations(
  resolve(import.meta.dirname, "../../migrations"),
);
// KEEPR_TEST_SUITE=stress selects the *.stress.spec.ts latency-budget suite
// run by the scheduled / manually dispatched stress workflow.
const stressSuite = process.env.KEEPR_TEST_SUITE === "stress";

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
    include: stressSuite
      ? ["apps/api/test/**/*.stress.spec.ts"]
      : ["apps/api/test/**/*.spec.ts"],
    exclude: stressSuite
      ? [...configDefaults.exclude]
      : [...configDefaults.exclude, "**/*.stress.spec.ts"],
    hookTimeout: 30_000,
  },
});
