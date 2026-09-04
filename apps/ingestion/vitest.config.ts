import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { resolve } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";
import {
  cloudflareApiMock,
  createFakePublisher,
  workersPoolScenarios,
} from "../../test/support/fake-publisher/index.ts";

const migrations = await readD1Migrations(
  resolve(import.meta.dirname, "../../migrations"),
);
// KEEPR_TEST_SUITE=stress selects the *.stress.spec.ts suite (scheduled /
// manually dispatched CI job) and keeps production source-host pacing so
// stress measurements stay production-faithful. The default suite runs with
// the immediate pacing override instead of sleeping ~1s per simulated fetch.
const stressSuite = process.env.KEEPR_TEST_SUITE === "stress";
const currentSchemaMigrationLevel = Number.parseInt(
  migrations.at(-1)?.name ?? "",
  10,
);
if (!Number.isSafeInteger(currentSchemaMigrationLevel)) {
  throw new Error("The current schema migration level could not be derived.");
}

// The test suite is hermetic: it pins the placeholder resource identifiers
// its Cloudflare API mocks and fixtures assert on, independent of the
// provisioned production ids in wrangler.jsonc.
const cloudflareAccountId = "0123456789abcdef0123456789abcdef";
const catalogueD1DatabaseId = "00000000-0000-0000-0000-000000000001";
const disposableD1DatabaseId = "00000000-0000-0000-0000-000000000002";
const d1VerificationToken = "vitest-d1-verification-token-active";

// The fake internet behind every outbound fetch: the Cloudflare API mock and
// the shared fake publisher's workers-pool scenario catalogue.
const fakePublisher = createFakePublisher({
  scenarios: [
    cloudflareApiMock({
      accountId: cloudflareAccountId,
      disposableDatabaseId: disposableD1DatabaseId,
      verificationToken: d1VerificationToken,
      schemaMigrationLevel: currentSchemaMigrationLevel,
    }),
    ...workersPoolScenarios,
  ],
});

export default defineConfig({
  plugins: [
    cloudflareTest({
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
          ADMINISTRATION_KEY_REPLACEMENT:
            "vitest-administration-key-replacement-slot",
          ADMINISTRATION_CLOCK_MODE: "request",
          D1_VERIFICATION_TOKEN: d1VerificationToken,
          D1_EXPORT_TOKEN: "vitest-d1-export-token-active",
          TEST_MIGRATIONS: migrations,
        },
        // Miniflare hands over undici's Request; the publisher speaks the
        // Workers Request the scenarios were written against.
        outboundService: (request) =>
          fakePublisher.fetch(request as unknown as Request),
      },
    }),
  ],
  test: {
    include: stressSuite
      ? ["apps/ingestion/test/**/*.stress.spec.ts"]
      : ["apps/ingestion/test/**/*.spec.ts"],
    exclude: stressSuite
      ? [...configDefaults.exclude]
      : [...configDefaults.exclude, "**/*.stress.spec.ts"],
    // Reconciliation files race Workerd polling deadlines when
    // over-parallelized; two workers match the retired shard runner's proven
    // concurrency.
    maxWorkers: 2,
    hookTimeout: 30_000,
    // Workflow steps still running when a file's isolated runtime is torn
    // down forward their operational logs over an rpc that has already
    // closed. Vitest reports that race as an unhandled rejection and fails
    // the run even though every test passed; only that teardown error is
    // ignored here.
    onUnhandledError(error) {
      if (
        error.name === "EnvironmentTeardownError" &&
        /Closing rpc while ".+" was pending/u.test(error.message)
      ) {
        return false;
      }
    },
    testTimeout: 30_000,
  },
});
