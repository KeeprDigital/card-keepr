import { resolve } from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import type { Miniflare } from "miniflare";
import { configDefaults, defineConfig } from "vitest/config";
import {
  cloudflareApiMock,
  createFakePublisher,
  workersPoolScenarios,
} from "../../test/support/fake-publisher/index.ts";
import { SqliteRestore } from "../../test/support/fake-publisher/sqlite-restore.ts";
import { syntheticSourceAdapterMigration } from "../../test/support/source-adapters/migration";

const migrations = await readD1Migrations(resolve(import.meta.dirname, "../../migrations"));
// KEEPR_TEST_SUITE=stress selects the *.stress.spec.ts suite (scheduled /
// manually dispatched CI job) and keeps production source-host pacing so
// stress measurements stay production-faithful. The default suite runs with
// the immediate pacing override instead of sleeping ~1s per simulated fetch.
const stressSuite = process.env.KEEPR_TEST_SUITE === "stress";
// The test suite is hermetic: it pins the placeholder resource identifiers
// its Cloudflare API mocks and fixtures assert on, independent of the
// provisioned production ids in wrangler.jsonc.
const cloudflareAccountId = "0123456789abcdef0123456789abcdef";
const catalogueD1DatabaseId = "00000000-0000-0000-0000-000000000001";
const disposableD1DatabaseId = "00000000-0000-0000-0000-000000000002";
const d1VerificationToken = "vitest-d1-verification-token-active";

// The fake internet behind every outbound fetch: the Cloudflare API mock and
// the shared fake publisher's workers-pool scenario catalogue.
// The installed Miniflare V4FetchHandler supplies the owning runtime as its
// second argument. Keep each runtime's REST fixture and restore database isolated.
const publishers = new WeakMap<Miniflare, ReturnType<typeof createFakePublisher>>();
function publisherFor(miniflare: Miniflare) {
  const existing = publishers.get(miniflare);
  if (existing !== undefined) return existing;
  const publisher = createFakePublisher({
    scenarios: [
      cloudflareApiMock({
        accountId: cloudflareAccountId,
        disposableDatabaseId: disposableD1DatabaseId,
        verificationToken: d1VerificationToken,
        restore: new SqliteRestore(),
        async exportSql() {
          const database = await miniflare.getD1Database("CATALOGUE_DB");
          // This is Wrangler's installed local D1 export seam: actual schema and
          // rows, including its fail-closed rejection of remaining virtual tables.
          const rows = await database.prepare("PRAGMA miniflare_d1_export(?,?,?);").bind(0, 0).raw<string[]>();
          const statements = rows[0];
          if (statements === undefined) throw new Error("Local D1 export returned no SQL.");
          return statements.join("\n");
        },
      }),
      ...workersPoolScenarios,
    ],
  });
  publishers.set(miniflare, publisher);
  return publisher;
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: resolve(import.meta.dirname, "../../test/support/ingestion-worker.ts"),
      wrangler: {
        configPath: resolve(import.meta.dirname, "wrangler.jsonc"),
      },
      miniflare: {
        d1Databases: ["SCRATCH_DB"],
        bindings: {
          // Tests mount at the root; the mounted-path behaviour is covered
          // by the public-mount spec, which overrides the base per request.
          PUBLIC_BASE_URL: "http://127.0.0.1:8788",
          SOURCE_HOST_PACING_MODE: stressSuite ? "production" : "immediate",
          CLOUDFLARE_ACCOUNT_ID: cloudflareAccountId,
          CATALOGUE_D1_DATABASE_ID: catalogueD1DatabaseId,
          DISPOSABLE_D1_DATABASE_ID: disposableD1DatabaseId,
          ADMINISTRATION_KEY: "vitest-administration-key",
          ADMINISTRATION_KEY_REPLACEMENT: "vitest-administration-key-replacement-slot",
          ADMINISTRATION_CLOCK_MODE: "request",
          D1_VERIFICATION_TOKEN: d1VerificationToken,
          D1_EXPORT_TOKEN: "vitest-d1-export-token-active",
          TEST_MIGRATIONS: [...migrations, syntheticSourceAdapterMigration],
        },
        // Miniflare hands over undici's Request; the publisher speaks the
        // Workers Request the scenarios were written against.
        outboundService: (request, miniflare) => publisherFor(miniflare).fetch(request as unknown as Request),
      },
    }),
  ],
  test: {
    // Each file boots a complete Workers runtime. Concurrent runtimes starve
    // Workflow polling on supported hosts and can leave timed-out test work
    // racing the next fixture. Keep per-file storage isolation and timeouts.
    maxWorkers: 1,
    include: stressSuite ? ["apps/ingestion/test/**/*.stress.spec.ts"] : ["apps/ingestion/test/**/*.spec.ts"],
    exclude: stressSuite ? [...configDefaults.exclude] : [...configDefaults.exclude, "**/*.stress.spec.ts"],
    hookTimeout: 30_000,
    // Workflow steps still running when a file's isolated runtime is torn
    // down forward their operational logs over an rpc that has already
    // closed. Vitest reports that race as an unhandled rejection and fails
    // the run even though every test passed; only that teardown error is
    // ignored here.
    onUnhandledError(error) {
      if (error.name === "EnvironmentTeardownError" && /Closing rpc while ".+" was pending/u.test(error.message)) {
        return false;
      }
    },
    testTimeout: 30_000,
  },
});
