import { stagingStateFixture as fixture } from "./helpers/staging-state.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { stagingWorkflowFixture } from "./helpers/staging-workflow.mjs";
import { execFileSync } from "node:child_process";

test("staging retains its own exact plan and refuses successful validation without actual deployment evidence", async (t) => {
  const production = await fixture(t);
  const staging = await fixture(t);
  const { token } = await stagingWorkflowFixture(t);
  const { handleStagingAuthorization } = await production.vite.ssrLoadModule(
    "/src/catalogue/ingestion/staging-authorization.ts",
  );
  const { handleStagingDeployment, handleStagingOutcome, showStagingDeployment } = await staging.vite.ssrLoadModule(
    "/src/catalogue/ingestion/staging-deployment.ts",
  );
  const now = new Date().toISOString();
  const preview = await production.resolveStagingRelease(
    production.database,
    production.bucket,
    { ...production.choices, prepare: true },
    production.target,
    now,
  );
  const intent = await production.resolveStagingRelease(
    production.database,
    production.bucket,
    { ...production.choices, confirmation: preview.confirmation },
    production.target,
    now,
  );
  const provider = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url) === "https://card.keepr.digital/ingest/v1/staging-release-authorizations")
      return handleStagingAuthorization(
        new Request(url, options),
        { KEEPR_ENVIRONMENT: "production", CATALOGUE_DB: production.database },
        now,
      );
    if (new URL(url).hostname === "api.cloudflare.com")
      return Response.json({
        success: true,
        result: [{ name: "card-keepr-disposable-verification-staging", uuid: "00000000-0000-0000-0000-000000000004" }],
      });
    return provider(url, options);
  };
  const env = {
    KEEPR_ENVIRONMENT: "staging",
    CATALOGUE_DB: staging.database,
    CATALOGUE_EXPORTS: staging.bucket,
    CLOUDFLARE_ACCOUNT_ID: production.target.cloudflare_account_id,
    CATALOGUE_D1_DATABASE_ID: "00000000-0000-0000-0000-000000000003",
    D1_VERIFICATION_TOKEN: "synthetic-stage-verification",
  };
  const request = async (body) =>
    new Request("https://card-staging.keepr.digital/ingest/v1/staging-deployments", {
      method: "POST",
      headers: { authorization: `Bearer ${await token()}`, "x-github-token": "synthetic-github-token" },
      body: JSON.stringify(body),
    });
  const identity = { release_id: "staging-237", intent_digest: intent.intent_digest };
  const prepared = await (await handleStagingDeployment(await request(identity), env, now)).json();
  assert.deepEqual(JSON.parse(prepared.prepared_plan_json).production_target.worker_scripts, [
    "card-keepr-api-staging",
    "card-keepr-ingestion-staging",
  ]);
  assert.deepEqual(await (await handleStagingDeployment(await request(identity), env, now)).json(), prepared);
  const outcome = {
    contract: "card-keepr-staging-outcome@1",
    intent_digest: intent.intent_digest,
    expected_head_sha: production.choices.expected_head_sha,
    state: "succeeded",
    deployment: { state: "succeeded", release_id: "staging-237", dispatch_digest: prepared.dispatch_digest },
    migration: {
      state: "succeeded",
      starting_level: intent.intent.production_start.migration_level,
      ending_level: intent.intent.production_start.migration_level,
      migration_digest: "e".repeat(64),
    },
    checks: intent.intent.required_checks.map((name) => ({
      name,
      state: "succeeded",
      evidence_sha256: "e".repeat(64),
    })),
    failure_code: null,
  };
  await assert.rejects(
    handleStagingOutcome(await request({ intent_digest: intent.intent_digest, outcome }), env, "staging-237", now),
    (error) => error.code === "staging_deployment_not_succeeded",
  );
  outcome.state = "failed";
  outcome.failure_code = "live_smoke_failed";
  outcome.deployment.state = "failed";
  outcome.checks.find((check) => check.name === "live-smoke").state = "failed";
  const recorded = await (
    await handleStagingOutcome(await request({ intent_digest: intent.intent_digest, outcome }), env, "staging-237", now)
  ).json();
  assert.equal((await showStagingDeployment(staging.database, "staging-237")).outcome.state, "failed");
  assert.deepEqual(
    await (
      await handleStagingOutcome(
        await request({ intent_digest: intent.intent_digest, outcome }),
        env,
        "staging-237",
        now,
      )
    ).json(),
    recorded,
  );
  assert.deepEqual(await production.showStagingRelease(production.database, "staging-237"), intent);
});

test("migration rehearsal traverses the recorded production predecessor independently of current staging", async () => {
  const { rehearseStagingMigrations } = await import("../scripts/staging-migrations.mjs");
  const expectedHeadSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const result = await rehearseStagingMigrations({ expectedHeadSha, productionStartingLevel: 31 });
  assert.equal(result.starting_level, 31);
  assert.equal(result.state, "succeeded");
  assert.equal(result.data_scope, "isolated_synthetic_baseline");
  assert.equal(result.migrations.find((migration) => migration.level === 32).phase, "forward-migration");
  await assert.rejects(
    rehearseStagingMigrations({ expectedHeadSha, productionStartingLevel: 9999 }),
    /production_starting_schema_not_rehearsable/u,
  );
});

test("a lost authorization response replays the same claim and deadline without granting another workflow attempt", async (t) => {
  const { vite, database, bucket, target, choices, resolveStagingRelease } = await fixture(t);
  const { token, state } = await stagingWorkflowFixture(t);
  const { handleStagingAuthorization } = await vite.ssrLoadModule("/src/catalogue/ingestion/staging-authorization.ts");
  const now = new Date().toISOString();
  const preview = await resolveStagingRelease(database, bucket, { ...choices, prepare: true }, target, now);
  const recorded = await resolveStagingRelease(
    database,
    bucket,
    { ...choices, confirmation: preview.confirmation },
    target,
    now,
  );
  const env = { KEEPR_ENVIRONMENT: "production", CATALOGUE_DB: database };
  const request = async (claims = {}) =>
    new Request("https://card.keepr.digital/ingest/v1/staging-release-authorizations", {
      method: "POST",
      headers: { authorization: `Bearer ${await token(claims)}`, "x-github-token": "synthetic-github-token" },
      body: JSON.stringify({ release_id: choices.release_id, intent_digest: recorded.intent_digest }),
    });
  const claimed = await (await handleStagingAuthorization(await request(), env, now)).json();
  const later = new Date(Date.parse(now) + 60_000).toISOString();
  assert.deepEqual(await (await handleStagingAuthorization(await request(), env, later)).json(), claimed);
  assert.equal(claimed.expires_at, recorded.intent.expires_at);
  state.runAttempt = 2;
  await assert.rejects(
    handleStagingAuthorization(await request({ run_attempt: "2" }), env, now),
    (error) => error.code === "staging_claim_conflict",
  );
  state.runAttempt = 1;
  await assert.rejects(
    handleStagingAuthorization(await request(), env, new Date(Date.parse(now) + 25 * 3600_000).toISOString()),
    (error) => error.code === "staging_intent_expired",
  );
});

test("owner intent retains actual production schema and exact commit across replay and later clock changes", async (t) => {
  const { database, bucket, target, choices, migrations, resolveStagingRelease, showStagingRelease } = await fixture(t);
  const now = "2026-09-14T10:00:00.000Z";
  const preview = await resolveStagingRelease(database, bucket, { ...choices, prepare: true }, target, now);
  await assert.rejects(
    resolveStagingRelease(database, bucket, { ...choices, validation_scope: "routine", prepare: true }, target, now),
    (error) => error.code === "staging_validation_scope_required",
  );
  const recorded = await resolveStagingRelease(
    database,
    bucket,
    { ...choices, confirmation: preview.confirmation },
    target,
    now,
  );
  assert.equal(recorded.intent.production_start.migration_level, Number.parseInt(migrations.at(-1), 10));
  assert.deepEqual(recorded.intent.production_start.target, target);
  assert.equal(recorded.intent.expected_head_sha, "a".repeat(40));
  assert.equal(recorded.intent.validation_reason, "unknown_transition");
  assert.deepEqual(await showStagingRelease(database, "staging-237"), recorded);
  assert.deepEqual(
    await resolveStagingRelease(
      database,
      bucket,
      { ...choices, confirmation: preview.confirmation },
      target,
      "2026-09-14T11:00:00.000Z",
    ),
    recorded,
  );
  await assert.rejects(
    resolveStagingRelease(
      database,
      bucket,
      { ...choices, expected_head_sha: "b".repeat(40), confirmation: preview.confirmation },
      target,
      now,
    ),
    (error) => error.code === "staging_intent_conflict",
  );
});
