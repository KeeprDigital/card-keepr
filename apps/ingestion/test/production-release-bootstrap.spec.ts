import * as publishedCatalogueQueries from "./query-helpers/published-catalogue";
import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { injectFixturePublication } from "./fixture-plan-injection";
import { administrationRequest } from "./runtime-helpers";

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };

beforeEach(async () => {
  await applyD1Migrations(testEnv.CATALOGUE_DB, testEnv.TEST_MIGRATIONS);
});

// Storage persists across the tests in this file, so the single test that
// publishes a revision also carries every assertion that needs an empty
// catalogue first.
test("a Bootstrap Mode Production Release names the Spine Revision", async () => {
  const intent = {
    ...(await bootstrapIntent("bootstrap-wrong")),
    expected_current_revision_id: "catrev_other",
    prepare: true,
  };
  const preview = await administrationRequest("/v1/production-releases", "POST", intent);
  expect(preview.status).toBe(409);
  await expect(preview.json()).resolves.toMatchObject({ code: "release_preflight_failed" });
});

test("Bootstrap Mode is reported and accepted only while the catalogue is provably empty, and switches off once a revision is published", async () => {
  const fresh = await administrationRequest("/v1/status", "GET");
  expect(fresh.status).toBe(200);
  const freshDocument = (await fresh.json()) as { release_preflight: Record<string, unknown> };
  expect(freshDocument.release_preflight).toMatchObject({
    bootstrap: true,
    recovery_bookmark: null,
    recovery_backup_attempt_id: null,
    retention_ready: false,
    smoke_targets: null,
  });

  const intent = await bootstrapIntent("bootstrap-1");
  const preview = await administrationRequest("/v1/production-releases", "POST", { ...intent, prepare: true });
  expect(preview.status).toBe(200);
  const resolved = (await preview.json()) as { confirmation: string };
  expect(resolved).toMatchObject({
    contract: "card-keepr-production-release-confirmation@1",
    release_id: "bootstrap-1",
    confirmation: expect.any(String),
  });
  const prepared = await administrationRequest("/v1/production-releases", "POST", {
    ...intent,
    confirmation: resolved.confirmation,
  });
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
  const populatedDocument = (await populated.json()) as {
    release_preflight: Record<string, unknown>;
    safe_state: Record<string, unknown>;
  };
  expect(populatedDocument.safe_state.current_revision_id).toBe(published);
  expect(populatedDocument.release_preflight.bootstrap).toBe(false);

  const late = await administrationRequest("/v1/production-releases", "POST", {
    ...(await bootstrapIntent("bootstrap-late")),
    prepare: true,
  });
  expect(late.status).toBe(409);
  await expect(late.json()).resolves.toMatchObject({ code: "bootstrap_not_applicable" });
});

async function bootstrapIntent(releaseId: string): Promise<Record<string, unknown>> {
  return {
    release_id: releaseId,
    idempotency_key: `${releaseId}-key`,
    expected_current_revision_id: "catrev_spine_000",
    expected_head_sha: "a".repeat(40),
    expected_actor: "keepr-release[bot]",
    expected_migration_level: await schemaMigrationLevel(),
    bootstrap: true,
    replacement_handoff: null,
  };
}

// The release gate binds the recorded schema level, which every migration
// in the repository advances; the plan reads it rather than pinning it.
async function schemaMigrationLevel(): Promise<number> {
  const state = await publishedCatalogueQueries
    .readCatalogueSchemaStateMigrationLevel(testEnv.CATALOGUE_DB)
    .first<{ migration_level: number }>();
  if (state === null) throw new Error("The schema level is unavailable.");
  return state.migration_level;
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
  const document = (await approved.json()) as { state: string; resulting_revision_id: string };
  expect(approved.status, JSON.stringify(document)).toBe(200);
  expect(document.state).toBe("published");
  return document.resulting_revision_id;
}
