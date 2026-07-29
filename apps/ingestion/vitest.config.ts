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
        bindings: {
          ADMINISTRATION_KEY: "vitest-administration-key",
          ADMINISTRATION_CLOCK_MODE: "request",
          TEST_MIGRATIONS: migrations,
        },
      },
    }),
  ],
  test: {
    include: ["apps/ingestion/test/**/*.spec.ts"],
  },
});
