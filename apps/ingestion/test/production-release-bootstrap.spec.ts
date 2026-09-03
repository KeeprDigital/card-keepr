import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { canonicalJson, sha256Text } from "../../../src/catalogue/serialization";
import { injectFixturePublication } from "./fixture-plan-injection";
import { administrationRequest } from "./runtime-helpers";

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };

beforeEach(async () => {
  await applyD1Migrations(testEnv.CATALOGUE_DB, testEnv.TEST_MIGRATIONS);
});

// Storage persists across the tests in this file, so the single test that
// publishes a revision also carries every assertion that needs an empty
// catalogue first.
test("Bootstrap Mode is reported and accepted only while the catalogue is provably empty, and switches off once a revision is published", async () => {
  const fresh = await administrationRequest("/v1/status", "GET");
  expect(fresh.status).toBe(200);
  const freshDocument = await fresh.json() as { release_preflight: Record<string, unknown> };
  expect(freshDocument.release_preflight).toMatchObject({
    bootstrap: true,
    recovery_bookmark: null,
    recovery_backup_attempt_id: null,
    retention_ready: false,
    smoke_targets: null,
  });

  const prepared = await administrationRequest("/v1/production-releases", "POST", await bootstrapPlan("bootstrap-1"));
  expect(prepared.status).toBe(201);
  await expect(prepared.json()).resolves.toMatchObject({
    contract: "card-keepr-production-release-request@1",
    release_id: "bootstrap-1",
    state: "requested",
    dispatch_digest: expect.stringMatching(/^[0-9a-f]{64}$/u),
  });

  const published = await publishFixtureRevision();

  const populated = await administrationRequest("/v1/status", "GET");
  expect(populated.status).toBe(200);
  const populatedDocument = await populated.json() as { release_preflight: Record<string, unknown>; safe_state: Record<string, unknown> };
  expect(populatedDocument.safe_state.current_revision_id).toBe(published);
  expect(populatedDocument.release_preflight.bootstrap).toBe(false);

  const late = await administrationRequest("/v1/production-releases", "POST", await bootstrapPlan("bootstrap-late"));
  expect(late.status).toBe(409);
  await expect(late.json()).resolves.toMatchObject({ code: "release_preflight_failed" });
});

test("a Bootstrap Mode Production Release names the Spine Revision", async () => {
  const plan = { ...await bootstrapPlan("bootstrap-wrong"), expected_current_revision_id: "catrev_other" };
  const prepared = await administrationRequest("/v1/production-releases", "POST", plan);
  expect(prepared.status).toBe(422);
  await expect(prepared.json()).resolves.toMatchObject({ code: "invalid_production_release_request" });
});

async function bootstrapPlan(releaseId: string): Promise<Record<string, unknown>> {
  const target = {
    cloudflare_account_id: testEnv.CLOUDFLARE_ACCOUNT_ID,
    worker_scripts: ["card-keepr-api", "card-keepr-ingestion"],
    d1_databases: [
      { name: "card-keepr-catalogue", id: testEnv.CATALOGUE_D1_DATABASE_ID },
      { name: "card-keepr-disposable-verification", id: testEnv.DISPOSABLE_D1_DATABASE_ID },
    ],
    r2_buckets: ["card-keepr-evidence", "card-keepr-printing-images", "card-keepr-catalogue-exports", "card-keepr-backups"],
  };
  return {
    release_id: releaseId,
    idempotency_key: `${releaseId}-key`,
    expected_current_revision_id: "catrev_spine_000",
    expected_head_sha: "a".repeat(40),
    expected_actor: "keepr-release[bot]",
    expected_migration_level: 1,
    production_target: target,
    production_target_digest: await sha256Text(canonicalJson(target)),
    bootstrap: true,
    recovery_bookmark: null,
    recovery_backup_attempt_id: null,
    smoke_targets: null,
    retained_revision_evidence: null,
    replacement_handoff: null,
  };
}

async function publishFixtureRevision(): Promise<string> {
  const started = await injectFixturePublication(testEnv.CATALOGUE_DB, testEnv.CATALOGUE_EXPORTS, {
    fixture: "first-catalogue",
    selected_games: ["one-piece"],
    idempotency_key: "bootstrap-first-catalogue",
  });
  const approved = await administrationRequest(`/v1/ingestion-runs/${String(started.id)}/approval`, "POST", {
    candidate_digest: started.candidate_digest,
    expected_current_revision_id: started.expected_current_revision_id,
    idempotency_key: "bootstrap-first-catalogue-approval",
  });
  const document = await approved.json() as { state: string; resulting_revision_id: string };
  expect(document.state).toBe("published");
  return document.resulting_revision_id;
}
