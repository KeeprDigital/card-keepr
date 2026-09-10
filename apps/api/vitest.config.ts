import { resolve } from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { configDefaults, defineConfig } from "vitest/config";
import { syntheticSourceAdapterMigration } from "../../test/support/source-adapters/migration";

const migrations = await readD1Migrations(resolve(import.meta.dirname, "../../migrations"));

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: resolve(import.meta.dirname, "../../test/support/api-worker.ts"),
      wrangler: {
        configPath: resolve(import.meta.dirname, "wrangler.jsonc"),
      },
      miniflare: {
        bindings: {
          // Tests mount at the root; the mounted-path behaviour is covered
          // by the public-mount spec, which overrides the base per request.
          PUBLIC_BASE_URL: "http://127.0.0.1:8787",
          API_BEARER_KEY: "vitest-api-key",
          API_BEARER_KEY_REPLACEMENT: "vitest-api-key-replacement-slot",
          TEST_MIGRATIONS: [...migrations, syntheticSourceAdapterMigration],
        },
      },
    }),
  ],
  test: {
    include: ["apps/api/test/**/*.spec.ts"],
    exclude: [...configDefaults.exclude, "**/*.stress.spec.ts"],
    maxWorkers: 2,
    hookTimeout: 30_000,
  },
});
