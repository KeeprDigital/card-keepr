import { applyD1Migrations, type D1Migration, env } from "cloudflare:test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import worker from "../src/index";
import document from "../../../contracts/admin-openapi.json";
import { assertHttpResponse } from "../../../test/support/http-contract";
import { handleProductionPromotion } from "../../../src/catalogue/ingestion/production-promotion";
import { recordStagingProtocolStatement } from "../../../src/catalogue/ingestion/staging-release-repository";
import { canonicalJson, catalogueStore } from "../../../src/catalogue/shared";
import {
  extendedScenarios,
  promotionAudience,
  requiredCiChecks,
  stagingAudience,
} from "../../../src/http/dev-workflow-identity.mjs";
import {
  approveNativeCandidateThroughBinding as approveNativeCandidate,
  prepareNativeCandidateThroughBinding as prepareNativeCandidate,
} from "./native-publication-helpers";
import { collect, requiredString } from "./reconciliation-helpers";
import { installWorkflowIsolation } from "./workflow-isolation";
import * as promotionQueries from "./query-helpers/production-promotion";

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };
installWorkflowIsolation();
const selected = "a".repeat(40);
const main = "b".repeat(40);
const releaseId = "staging-promotion-1";
const base = "http://127.0.0.1:8788";
const run = "456";

type Outcome = Record<string, unknown> & { deployment: Record<string, unknown> };
type World = {
  disposable: string;
  statuses: Record<string, unknown>[];
  extendedRun: Record<string, unknown>;
  jobs: Record<string, unknown>[];
  ciConclusion: string;
  staging: (request: Request) => Promise<Response>;
  stagingRequests: Request[];
};
let world: World;
let token: (changes?: Record<string, unknown>, at?: number) => Promise<string>;
let intent: {
  intent_digest: string;
  intent: Record<string, unknown> & { production_start: { migration_level: number } };
};
let claim: Record<string, unknown>;

beforeEach(async () => {
  await applyD1Migrations(testEnv.CATALOGUE_DB, testEnv.TEST_MIGRATIONS);
  const signer = await workflowSigner();
  token = signer.token;
  const provider = globalThis.fetch.bind(globalThis);
  world = {
    disposable: "00000000-0000-0000-0000-000000000002",
    statuses: [extendedStatus("success")],
    extendedRun: {
      repository: { id: 1313489088 },
      path: ".github/workflows/extended-scenarios.yml",
      event: "workflow_dispatch",
      head_branch: "main",
      head_sha: main,
      display_title: `extended-scenarios-${selected}`,
      status: "completed",
      conclusion: "success",
    },
    jobs: [
      { name: "select", status: "completed", conclusion: "success" },
      ...extendedScenarios.map((name) => ({ name: `scenario (${name})`, status: "completed", conclusion: "success" })),
    ],
    ciConclusion: "success",
    staging: async () => Response.json(outcomeReceipt(successfulOutcome())),
    stagingRequests: [],
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "token.actions.githubusercontent.com") return Response.json({ keys: [signer.jwk] });
    if (url.hostname === "api.cloudflare.com" && url.pathname.endsWith("/d1/database") && url.searchParams.has("name"))
      return Response.json({
        success: true,
        result: [{ name: "card-keepr-disposable-verification", uuid: world.disposable }],
      });
    if (url.hostname === "card-staging.keepr.digital") {
      const forwarded = new Request(url, init);
      world.stagingRequests.push(forwarded.clone());
      return world.staging(forwarded);
    }
    if (url.hostname !== "api.github.com") return provider(input, init);
    const path = url.pathname.replace("/repos/KeeprDigital/card-keepr", "");
    if (path === `/actions/runs/${run}` || path === "/actions/runs/789")
      return Response.json({
        repository: { id: 1313489088 },
        path: ".github/workflows/staging-deploy.yml",
        event: "workflow_dispatch",
        head_sha: main,
        head_branch: "main",
        run_attempt: 1,
        status: "in_progress",
        actor: { login: "owner" },
      });
    if (path === "/actions/runs/123")
      return Response.json({
        repository: { id: 1313489088 },
        path: ".github/workflows/ci.yml",
        event: "push",
        head_branch: "main",
        head_sha: selected,
        status: "completed",
        conclusion: "success",
        check_suite_id: 777,
      });
    if (path.startsWith("/compare/")) return Response.json({ status: "behind" });
    if (path === `/commits/${selected}/check-runs`)
      return Response.json({
        total_count: requiredCiChecks.length,
        check_runs: requiredCiChecks.map((name) => ({
          name,
          app: { slug: "github-actions" },
          check_suite: { id: 777 },
          head_sha: selected,
          status: "completed",
          conclusion: world.ciConclusion,
        })),
      });
    if (path === `/commits/${selected}/statuses`) return Response.json(world.statuses);
    if (path === "/actions/runs/900") return Response.json(world.extendedRun);
    if (path === "/actions/runs/900/jobs") return Response.json({ total_count: world.jobs.length, jobs: world.jobs });
    throw new Error(`Unexpected provider request ${url.href}`);
  });
  // The owner's existing CLI staging intent and the staging workflow's signed claim.
  const choices = {
    release_id: releaseId,
    idempotency_key: `${releaseId}-owner`,
    expected_head_sha: selected,
    expected_actor: "owner",
    ci_run_id: "123",
  };
  const preview = await owner("/v1/staging-releases", { ...choices, prepare: true });
  const { confirmation } = await preview.json<{ confirmation: string }>();
  const accepted = await owner("/v1/staging-releases", { ...choices, confirmation });
  expect(accepted.status, await accepted.clone().text()).toBe(201);
  intent = await accepted.json();
  const claimed = await worker.fetch(
    new Request(`${base}/v1/staging-release-authorizations`, {
      method: "POST",
      headers: { authorization: `Bearer ${await token(stagingClaims)}`, "x-github-token": "synthetic-github-token" },
      body: JSON.stringify({ release_id: releaseId, intent_digest: intent.intent_digest }),
    }),
    testEnv,
  );
  expect(claimed.status, await claimed.clone().text()).toBe(201);
  claim = await claimed.json();
});
afterEach(() => vi.restoreAllMocks());

test("a successful staging release promotes the same commit through a fresh Bootstrap Mode plan, idempotently", async () => {
  const response = await promote();
  expect(response.status, await response.clone().text()).toBe(201);
  await assertHttpResponse(document, "/v1/production-promotions", "post", response.clone());
  const receipt = await response.json<{ production_release: { dispatch_inputs: Record<string, string> } }>();
  expect(receipt).toMatchObject({
    contract: "card-keepr-production-promotion@1",
    staging_release_id: releaseId,
    expected_head_sha: selected,
    confirmed_by: `promotion:${releaseId}/${run}`,
    workflow_run_id: run,
    extended_scenarios: { status_id: "55", run_id: "900" },
    production_start: { migration_level: intent.intent.production_start.migration_level },
  });
  const inputs = receipt.production_release.dispatch_inputs;
  expect(inputs).toMatchObject({
    operation: "production_release",
    release_id: `promotion-${releaseId}`,
    idempotency_key: `promotion:${releaseId}:${run}`,
    expected_head_sha: selected,
    expected_actor: "github-actions[bot]",
    expected_current_revision: "catrev_spine_000",
    expected_migration_level: String(intent.intent.production_start.migration_level),
    bootstrap: "true",
    recovery_bookmark: "none",
  });
  // Production read the outcome from staging, forwarding only the signed promotion identity.
  expect(world.stagingRequests).toHaveLength(1);
  expect(world.stagingRequests[0]!.url).toBe(
    `https://card-staging.keepr.digital/ingest/v1/staging-deployments/${releaseId}/promotion-outcome`,
  );
  expect(await world.stagingRequests[0]!.json()).toEqual({ intent_digest: intent.intent_digest });

  // Exact replay returns the original record without re-evaluating newer evidence.
  world.statuses = [extendedStatus("failure")];
  const replay = await promote();
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(receipt);
  expect(await promotionQueries.promotionPlanCount(testEnv.CATALOGUE_DB).first("count")).toBe(1);

  // Another workflow run cannot promote, replay or substitute for the claiming run.
  const other = await promote({ token: await token({ run_id: "789" }) });
  expect(other.status).toBe(409);
  expect(await other.json()).toMatchObject({ code: "promotion_run_mismatch" });
  expect(await promotionQueries.promotionPlanCount(testEnv.CATALOGUE_DB).first("count")).toBe(1);
});

test.each<[string, string, () => Promise<void> | void, Record<string, unknown>?]>([
  ["stale target", "promotion_target_changed", () => void (world.disposable = "00000000-0000-0000-0000-00000000000f")],
  [
    "schema moved",
    "promotion_schema_changed",
    async () => void (await promotionQueries.advanceSchemaLevel(testEnv.CATALOGUE_DB).run()),
  ],
  [
    "competing release lease",
    "promotion_release_competing",
    async () =>
      void (await promotionQueries
        .holdProductionReleaseLease(testEnv.CATALOGUE_DB, "release-other", new Date(Date.now() + 600_000).toISOString())
        .run()),
  ],
  [
    "staging failed",
    "staging_outcome_failed",
    () => void (world.staging = async () => Response.json(outcomeReceipt(failedOutcome()))),
  ],
  [
    "staging outcome missing",
    "staging_outcome_missing",
    () =>
      void (world.staging = async () =>
        Response.json({ code: "staging_outcome_not_found", title: "Not found" }, { status: 404 })),
  ],
  [
    "staging outcome for another intent digest",
    "staging_outcome_mismatch",
    () =>
      void (world.staging = async () =>
        Response.json(outcomeReceipt({ ...successfulOutcome(), intent_digest: "f".repeat(64) }))),
  ],
  [
    "staging outcome for another commit",
    "staging_outcome_mismatch",
    () =>
      void (world.staging = async () =>
        Response.json(outcomeReceipt({ ...successfulOutcome(), expected_head_sha: "c".repeat(40) }))),
  ],
  [
    "staging outcome under another workflow claim",
    "staging_outcome_mismatch",
    () =>
      void (world.staging = async () =>
        Response.json({ ...outcomeReceipt(successfulOutcome()), authorization: { ...claim, workflow_run_id: "789" } })),
  ],
  ["extended scenarios missing", "extended_scenarios_missing", () => void (world.statuses = [])],
  [
    "extended scenarios pending",
    "extended_scenarios_pending",
    () => void (world.statuses = [extendedStatus("pending")]),
  ],
  ["extended scenarios failed", "extended_scenarios_failed", () => void (world.statuses = [extendedStatus("failure")])],
  [
    "extended run still in progress",
    "extended_scenarios_pending",
    () => void (world.extendedRun = { ...world.extendedRun, status: "in_progress", conclusion: null }),
  ],
  [
    "extended status forged by another identity",
    "extended_scenarios_unverified",
    () => void (world.statuses = [{ ...extendedStatus("success"), creator: { login: "someone" } }]),
  ],
  [
    "extended status pointing at another workflow",
    "extended_scenarios_unverified",
    () => void (world.extendedRun = { ...world.extendedRun, path: ".github/workflows/pr-title.yml" }),
  ],
  [
    "extended run for another commit",
    "extended_scenarios_unverified",
    () => void (world.extendedRun = { ...world.extendedRun, display_title: `extended-scenarios-${"c".repeat(40)}` }),
  ],
  [
    "extended scenario job not successful",
    "extended_scenarios_unverified",
    () =>
      void (world.jobs = world.jobs.map((job) =>
        job.name === "scenario (composed-recovery)" ? { ...job, conclusion: "skipped" } : job,
      )),
  ],
  ["selected commit CI not green", "promotion_ci_not_verified", () => void (world.ciConclusion = "failure")],
  ["commit substitution", "promotion_commit_mismatch", () => undefined, { expected_head_sha: "c".repeat(40) }],
  ["intent digest substitution", "promotion_intent_mismatch", () => undefined, { intent_digest: "f".repeat(64) }],
])("promotion stops, typed and recorded, on %s", async (_name, code, arrange, body) => {
  await arrange();
  const response = await promote({ body });
  expect(response.status, await response.clone().text()).toBeGreaterThanOrEqual(400);
  await assertHttpResponse(document, "/v1/production-promotions", "post", response.clone());
  expect(await response.json()).toMatchObject({ code });
  expect(await promotionQueries.promotionStopCodes(testEnv.CATALOGUE_DB, releaseId).all()).toMatchObject({
    results: [{ code }],
  });
  expect(await promotionQueries.promotionPlanCount(testEnv.CATALOGUE_DB).first("count")).toBe(0);
});

test("a stop never blocks the same run's retry once its evidence completes", async () => {
  world.statuses = [extendedStatus("pending")];
  expect(await (await promote()).json()).toMatchObject({ code: "extended_scenarios_pending" });
  world.statuses = [extendedStatus("success")];
  expect((await promote()).status).toBe(201);
});

test("an expired owner intent is refused, and an unsigned caller leaves no evidence", async () => {
  const later = Date.parse(String(intent.intent.expires_at)) + 60_000;
  const expired = handleProductionPromotion(
    await promotionRequest({ token: await token({}, later) }),
    promotionEnvironment(),
    new Date(later).toISOString(),
  );
  await expect(expired).rejects.toMatchObject({ code: "promotion_intent_expired" });
  const unsigned = await promote({ token: "not-a-jwt" });
  expect(unsigned.status).toBe(403);
  expect(await unsigned.json()).toMatchObject({ code: "invalid_promotion_workflow_attestation" });
  // The staging identity's audience cannot promote.
  const staging = await promote({ token: await token(stagingClaims) });
  expect(staging.status).toBe(403);
  expect(await promotionQueries.promotionStopCodes(testEnv.CATALOGUE_DB, releaseId).all()).toMatchObject({
    results: [{ code: "promotion_intent_expired" }],
  });
});

// Bootstrap off: a Catalogue Revision published after the intent is resolved
// afresh (bootstrap=false, the new revision) instead of reusing the empty
// catalogue's plan, so recovery evidence is then required.
test("a revision published after the intent is re-resolved, not reused, and requires recovery evidence", async () => {
  const collection = await collect("/reconciliation/base", "promotion-first-catalogue");
  const candidate = await prepareNativeCandidate(
    collection.id,
    "one-piece",
    "catrev_spine_000",
    "promotion-first-candidate",
  );
  await approveNativeCandidate(candidate, "promotion-first-catalogue-approval");
  const response = await promote();
  expect(response.status, await response.clone().text()).toBe(409);
  const problem = await response.json<{ code: string; detail: string }>();
  expect(problem.code).toBe("promotion_preflight_failed");
  expect(await promotionQueries.promotionPlanCount(testEnv.CATALOGUE_DB).first("count")).toBe(0);
});

// The non-Bootstrap path end to end (#238): four real publications with verified
// backups and exports leave current-plus-two recovery evidence and an archived
// revision, so the promotion resolves an ordinary guarded plan from that evidence.
// The endpoint is dormant (the owner promotes with `pnpm release:promote`); this
// keeps its shared resolver path proven for a later hands-off promotion.
test("a populated catalogue promotes through a fresh plan bound to its recovery evidence", async () => {
  let head = "catrev_spine_000";
  for (let sequence = 1; sequence <= 4; sequence += 1) {
    const collection = await collect(
      `/reconciliation/search-repair-retention-${sequence}`,
      `promotion-retention-${sequence}`,
    );
    const candidate = await prepareNativeCandidate(
      collection.id,
      "one-piece",
      head,
      `promotion-retention-candidate-${sequence}`,
    );
    const published = await approveNativeCandidate(candidate, `promotion-retention-publish-${sequence}`);
    expect(published.response.status).toBe(200);
    head = requiredString(published.document, "resulting_revision_id");
  }
  const status = await worker.fetch(
    new Request(`${base}/v1/status`, { headers: { authorization: "Bearer vitest-administration-key" } }),
    testEnv,
  );
  const preflight = (await status.json<{ release_preflight: Record<string, unknown> }>()).release_preflight;
  expect(preflight).toMatchObject({ bootstrap: false, retention_ready: true });

  const response = await promote();
  expect(response.status, await response.clone().text()).toBe(201);
  await assertHttpResponse(document, "/v1/production-promotions", "post", response.clone());
  const receipt = await response.json<{ production_release: { dispatch_inputs: Record<string, string> } }>();
  const inputs = receipt.production_release.dispatch_inputs;
  expect(inputs).toMatchObject({
    operation: "production_release",
    release_id: `promotion-${releaseId}`,
    idempotency_key: `promotion:${releaseId}:${run}`,
    expected_head_sha: selected,
    expected_actor: "github-actions[bot]",
    expected_current_revision: head,
    bootstrap: "false",
    recovery_bookmark: preflight.recovery_bookmark,
    recovery_backup_attempt_id: preflight.recovery_backup_attempt_id,
    replacement_recovery_id: "none",
  });
  expect(JSON.parse(inputs.retained_revision_evidence_json!)).toEqual(preflight.retained_revision_evidence);
  expect(JSON.parse(inputs.smoke_targets_json!)).toEqual(preflight.smoke_targets);
  expect(JSON.parse(inputs.smoke_targets_json!).revisions[0].revision_id).toBe(head);
}, 120_000);

test("staging serves its recorded outcome only to the run and owner that recorded it", async () => {
  const stagingEnv = { ...testEnv, KEEPR_ENVIRONMENT: "staging" } as unknown as Env;
  const read = async (changes: Record<string, unknown> = {}, digest = intent.intent_digest) =>
    worker.fetch(
      new Request(`${base}/v1/staging-deployments/${releaseId}/promotion-outcome`, {
        method: "POST",
        headers: { authorization: `Bearer ${await token(changes)}`, "x-github-token": "synthetic-github-token" },
        body: JSON.stringify({ intent_digest: digest }),
      }),
      stagingEnv,
    );
  const missing = await read();
  expect(missing.status).toBe(404);
  expect(await missing.json()).toMatchObject({ code: "staging_outcome_not_found" });
  const receipt = outcomeReceipt(successfulOutcome());
  await recordStagingProtocolStatement(catalogueStore(testEnv.CATALOGUE_DB), {
    key: `staging-outcome:${releaseId}`,
    operation: "staging_release_outcome",
    request: canonicalJson(claim),
    response: canonicalJson(receipt),
    at: receipt.recorded_at,
  }).run();
  const served = await read();
  expect(served.status, await served.clone().text()).toBe(200);
  await assertHttpResponse(document, "/v1/staging-deployments/{release}/promotion-outcome", "post", served.clone());
  expect(await served.json()).toEqual(receipt);
  const otherRun = await read({ run_id: "789" });
  expect(otherRun.status).toBe(409);
  const otherDigest = await read({}, "f".repeat(64));
  expect(otherDigest.status).toBe(409);
  const unsigned = await read({ aud: stagingAudience });
  expect(unsigned.status).toBe(403);
  const onProduction = await worker.fetch(
    new Request(`${base}/v1/staging-deployments/${releaseId}/promotion-outcome`, { method: "POST", body: "{}" }),
    testEnv,
  );
  expect(onProduction.status).toBe(404);
});

const stagingClaims = {
  aud: stagingAudience,
  sub: "repo:KeeprDigital/card-keepr:environment:staging",
  environment: "staging",
};

function extendedStatus(state: string) {
  return {
    id: 55,
    context: "extended-scenarios",
    state,
    creator: { login: "github-actions[bot]" },
    target_url: "https://github.com/KeeprDigital/card-keepr/actions/runs/900",
  };
}

function successfulOutcome(): Outcome {
  const level = intent.intent.production_start.migration_level;
  return {
    contract: "card-keepr-staging-outcome@1",
    intent_digest: intent.intent_digest,
    expected_head_sha: selected,
    state: "succeeded",
    deployment: { state: "succeeded", release_id: releaseId, dispatch_digest: "d".repeat(64) },
    migration: { state: "succeeded", starting_level: level, ending_level: level, migration_digest: "e".repeat(64) },
    checks: ["exact-commit-ci", "migration-rehearsal", "live-smoke"].map((name) => ({
      name,
      state: "succeeded",
      evidence_sha256: "e".repeat(64),
    })),
    failure_code: null,
  };
}

function failedOutcome(): Outcome {
  const outcome = successfulOutcome();
  return {
    ...outcome,
    state: "failed",
    deployment: { ...outcome.deployment, state: "failed" },
    checks: (outcome.checks as Record<string, unknown>[]).map((check) =>
      check.name === "live-smoke" ? { ...check, state: "failed" } : check,
    ),
    failure_code: "live_smoke_failed",
  };
}

function outcomeReceipt(outcome: Outcome) {
  return { release_id: releaseId, authorization: claim, outcome, recorded_at: new Date().toISOString() };
}

async function owner(path: string, body: Record<string, unknown>) {
  return worker.fetch(
    new Request(`${base}${path}`, {
      method: "POST",
      headers: { authorization: "Bearer vitest-administration-key", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    testEnv,
  );
}

async function promotionRequest(options: { token?: string; body?: Record<string, unknown> } = {}) {
  return new Request(`${base}/v1/production-promotions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.token ?? (await token())}`,
      "x-github-token": "synthetic-github-token",
    },
    body: JSON.stringify({
      release_id: releaseId,
      intent_digest: intent.intent_digest,
      expected_head_sha: selected,
      ...options.body,
    }),
  });
}

async function promote(options: { token?: string; body?: Record<string, unknown> } = {}) {
  return worker.fetch(await promotionRequest(options), testEnv);
}

function promotionEnvironment() {
  return {
    KEEPR_ENVIRONMENT: "production",
    CATALOGUE_DB: catalogueStore(testEnv.CATALOGUE_DB),
    CATALOGUE_EXPORTS: testEnv.CATALOGUE_EXPORTS,
    CLOUDFLARE_ACCOUNT_ID: testEnv.CLOUDFLARE_ACCOUNT_ID,
    CATALOGUE_D1_DATABASE_ID: testEnv.CATALOGUE_D1_DATABASE_ID,
    D1_VERIFICATION_TOKEN: testEnv.D1_VERIFICATION_TOKEN,
  };
}

// Test-only keys sign actual JWTs; only GitHub's issuer and API are simulated.
async function workflowSigner() {
  const key = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = {
    ...((await crypto.subtle.exportKey("jwk", key.publicKey)) as JsonWebKey),
    kid: "promotion-test",
    alg: "RS256",
    use: "sig",
  };
  const encode = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
  const json = (value: unknown) => encode(new TextEncoder().encode(JSON.stringify(value)));
  const sign = async (changes: Record<string, unknown> = {}, at = Date.now()) => {
    const now = Math.floor(at / 1000);
    const claims = {
      iss: "https://token.actions.githubusercontent.com",
      aud: promotionAudience,
      sub: "repo:KeeprDigital/card-keepr:environment:production",
      repository: "KeeprDigital/card-keepr",
      repository_id: "1313489088",
      repository_owner_id: "114643329",
      environment: "production",
      ref: "refs/heads/main",
      event_name: "workflow_dispatch",
      workflow_ref: "KeeprDigital/card-keepr/.github/workflows/staging-deploy.yml@refs/heads/main",
      sha: main,
      workflow_sha: main,
      actor: "owner",
      run_id: run,
      run_attempt: "1",
      jti: `promotion-${now}`,
      iat: now,
      nbf: now,
      exp: now + 300,
      ...changes,
    };
    const body = `${json({ alg: "RS256", typ: "JWT", kid: "promotion-test" })}.${json(claims)}`;
    const signature = new Uint8Array(
      await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, new TextEncoder().encode(body)),
    );
    return `${body}.${encode(signature)}`;
  };
  return { jwk, token: sign };
}
