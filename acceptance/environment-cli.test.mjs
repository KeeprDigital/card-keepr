import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("selecting dev never falls back to unscoped production credentials", () => {
  const result = spawnSync(process.execPath, ["cli/keepr.mjs", "status", "--target", "dev", "--json"], {
    encoding: "utf8",
    env: {
      ...process.env,
      KEEPR_ADMINISTRATION_KEY: "synthetic-production-key",
      KEEPR_API_KEY: "synthetic-production-api-key",
    },
  });
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).code, "configuration_error");
  assert.match(JSON.parse(result.stdout).detail, /KEEPR_DEV_ADMINISTRATION_KEY/u);
});

test("dev status uses only its scoped credential and canonical dev route", async (t) => {
  const { main } = await import("../cli/keepr.mjs");
  const observed = [];
  const originalFetch = globalThis.fetch;
  const originalWrite = process.stdout.write;
  t.after(() => {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalWrite;
  });
  globalThis.fetch = async (url, options) => {
    observed.push({ url: String(url), token: new Headers(options.headers).get("authorization") });
    return Response.json({
      contract: "card-keepr-cli-presentation@1",
      text: "Dev status",
      exit_code: 0,
      document: { state: "dev" },
    });
  };
  process.stdout.write = () => true;
  const result = await main(["status", "--target", "dev", "--json"], {
    KEEPR_DEV_ADMINISTRATION_KEY: "synthetic-dev-key",
    KEEPR_ADMINISTRATION_KEY: "synthetic-production-key",
    KEEPR_INGESTION_URL: "https://card.keepr.digital/ingest",
  });
  assert.equal(result, 0);
  assert.deepEqual(observed, [
    { url: "https://dev.card.keepr.digital/ingest/v1/status", token: "Bearer synthetic-dev-key" },
  ]);
});

test("isolated dev config rejects production D1 identities", async () => {
  const { devConfigurations } = await import("../scripts/dev-environment.mjs");
  await assert.rejects(
    devConfigurations({
      accountId: "3ec389380c7b82e6a172e6f351d4aad9",
      catalogueId: "2469f888-1530-4bef-bc58-17dc298bb598",
      disposableId: "00000000-0000-0000-0000-000000000002",
    }),
    /dev_database_isolation_required/u,
  );
  const configs = await devConfigurations({
    accountId: "3ec389380c7b82e6a172e6f351d4aad9",
    catalogueId: "00000000-0000-0000-0000-000000000001",
    disposableId: "00000000-0000-0000-0000-000000000002",
  });
  assert.equal(configs.api.name, "card-keepr-api-dev");
  assert.equal(configs.ingestion.services[0].service, "card-keepr-ingestion-dev");
  assert.equal(configs.ingestion.vars.KEEPR_ENVIRONMENT, "dev");
  assert.equal(configs.api.vars.PUBLIC_BASE_URL, "https://dev.card.keepr.digital/api");
  assert.deepEqual(
    configs.ingestion.r2_buckets.map((item) => item.bucket_name),
    [
      "card-keepr-evidence-dev",
      "card-keepr-printing-images-dev",
      "card-keepr-catalogue-exports-dev",
      "card-keepr-backups-dev",
    ],
  );
});

test("dev provisioning refuses unknown capacity and preserves replacement recovery headroom", async () => {
  const { verifyDevCapacity } = await import("../scripts/dev-capacity.mjs");
  const evidence = {
    workers_plan: "free",
    plan_evidence: "synthetic owner confirmation",
    account_id: "0123456789abcdef0123456789abcdef",
    observed_at: "2026-09-06T12:00:00.000Z",
    d1_count: 6,
    d1_total_bytes: 34308096,
    d1_max_bytes: 30011392,
    worker_count: 5,
    r2_count: 7,
  };
  const now = Date.parse("2026-09-06T12:10:00.000Z");
  assert.equal(verifyDevCapacity(evidence, now).reserved_replacement_databases, 2);
  assert.equal(verifyDevCapacity({ ...evidence, workers_plan: "unknown" }, now).assessed_limits, "free-conservative");
  assert.throws(
    () => verifyDevCapacity({ ...evidence, workers_plan: null }, now),
    /fresh_confirmed_capacity_evidence_required/u,
  );
  assert.throws(() => verifyDevCapacity({ ...evidence, d1_count: 7 }, now), /insufficient_dev_replacement_headroom/u);
  assert.throws(() => verifyDevCapacity(evidence, now + 3600_000), /fresh_confirmed_capacity_evidence_required/u);
});
