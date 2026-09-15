import { applyD1Migrations, type D1Migration, env } from "cloudflare:test";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import worker from "../src/index";
import arrayIntent from "./fixtures/staging-array-intent.json";
import nestedIntent from "./fixtures/staging-nested-intent.json";
import { retainedStagingIntentStatement } from "./query-helpers/staging-intent";
import document from "../../../contracts/admin-openapi.json";
import { assertHttpResponse } from "../../../test/support/http-contract";

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };
beforeEach(async () => {
  await applyD1Migrations(testEnv.CATALOGUE_DB, testEnv.TEST_MIGRATIONS);
});
afterEach(() => vi.restoreAllMocks());

test("owner HTTP intent requires administration auth and replays without a fresh provider dependency", async () => {
  const id = "fresh";
  const validation_scope = "auto";
  const request = (path: string, body?: Record<string, unknown>, authenticated = true) =>
    new Request(`http://127.0.0.1:8788${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        ...(authenticated ? { authorization: "Bearer vitest-administration-key" } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const choices = {
    release_id: `stage-http-${id}`,
    idempotency_key: `stage-http-owner-${id}`,
    expected_head_sha: "a".repeat(40),
    expected_actor: "owner",
    ci_run_id: "123",
    validation_scope,
  };
  const unauthorized = await worker.fetch(
    request("/v1/staging-releases", { ...choices, prepare: true }, false),
    testEnv,
  );
  expect(unauthorized.status).toBe(401);
  const provider = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({
      success: true,
      result: [{ name: "card-keepr-disposable-verification", uuid: "00000000-0000-0000-0000-000000000002" }],
    }),
  );
  const preview = await worker.fetch(request("/v1/staging-releases", { ...choices, prepare: true }), testEnv);
  expect(preview.status, await preview.clone().text()).toBe(200);
  await assertHttpResponse(document, "/v1/staging-releases", "post", preview);
  const { confirmation } = await preview.json<{ confirmation: string }>();
  const accepted = await worker.fetch(request("/v1/staging-releases", { ...choices, confirmation }), testEnv);
  expect(accepted.status).toBe(201);
  await assertHttpResponse(document, "/v1/staging-releases", "post", accepted);
  const intent = await accepted.json<{ intent_digest: string; intent: Record<string, unknown> }>();
  expect(intent.intent).toMatchObject({ validation_scope: "full", validation_reason: "unknown_transition" });
  provider.mockImplementation(async () => {
    throw new Error("provider unavailable after accepted owner request");
  });
  const replay = await worker.fetch(request("/v1/staging-releases", { ...choices, confirmation }), testEnv);
  expect(replay.status).toBe(201);
  expect(await replay.json()).toEqual(intent);
  const status = await worker.fetch(request(`/v1/staging-releases/${choices.release_id}`), testEnv);
  expect(status.status).toBe(200);
  await assertHttpResponse(document, "/v1/staging-releases/{release}", "get", status);
  expect(await status.json()).toMatchObject({ ...intent, authorization: null });
  const wrongAuthority = await worker.fetch(
    request("/v1/staging-release-authorizations", {
      release_id: `stage-http-${id}`,
      intent_digest: intent.intent_digest,
    }),
    testEnv,
  );
  expect(wrongAuthority.status).toBe(403);
  expect(await wrongAuthority.json()).toMatchObject({ code: "invalid_staging_workflow_attestation" });
  expect((await worker.fetch(request(`/v1/staging-deployments/${choices.release_id}`), testEnv)).status).toBe(404);

  // The external production authorization is controlled here; signed issuer,
  // exact-attempt and expiry checks remain exercised by staging-release-state.
  const authorizedAt = new Date().toISOString();
  const claim = {
    contract: "card-keepr-staging-authorization@1",
    intent: intent.intent,
    intent_digest: intent.intent_digest,
    workflow_run_id: "991",
    workflow_run_attempt: "1",
    authorized_at: authorizedAt,
    preparation_expires_at: new Date(Date.parse(authorizedAt) + 300_000).toISOString(),
    expires_at: intent.intent.expires_at,
  };
  provider.mockImplementation(async (url) =>
    String(url).endsWith("/v1/staging-release-authorizations")
      ? Response.json(claim)
      : Response.json({
          success: true,
          result: [
            { name: "card-keepr-disposable-verification-staging", uuid: "00000000-0000-0000-0000-000000000004" },
          ],
        }),
  );
  const stagingEnv = {
    ...testEnv,
    KEEPR_ENVIRONMENT: "staging",
    CATALOGUE_D1_DATABASE_ID: "00000000-0000-0000-0000-000000000003",
  } as unknown as Env;
  const preparation = await worker.fetch(
    request("/v1/staging-deployments", { release_id: choices.release_id, intent_digest: intent.intent_digest }),
    stagingEnv,
  );
  expect(preparation.status, await preparation.clone().text()).toBe(201);
  const prepared = await preparation.json<{ dispatch_digest: string }>();
  const inspectPath = `/v1/staging-deployments/${choices.release_id}`;
  const preparing = await worker.fetch(request(inspectPath), stagingEnv);
  expect(preparing.status, await preparing.clone().text()).toBe(200);
  await assertHttpResponse(document, "/v1/staging-deployments/{release}", "get", preparing);
  expect(await preparing.json()).toMatchObject({ outcome: null, deployment: prepared });
  const outcome = {
    contract: "card-keepr-staging-outcome@1",
    intent_digest: intent.intent_digest,
    expected_head_sha: choices.expected_head_sha,
    state: "failed",
    deployment: { state: "failed", release_id: choices.release_id, dispatch_digest: prepared.dispatch_digest },
    migration: {
      state: "succeeded",
      starting_level: (intent.intent.production_start as { migration_level: number }).migration_level,
      ending_level: (intent.intent.production_start as { migration_level: number }).migration_level,
      migration_digest: "e".repeat(64),
    },
    checks: (intent.intent.required_checks as string[]).map((name) => ({
      name,
      state: name === "live-smoke" ? "failed" : "succeeded",
      evidence_sha256: "e".repeat(64),
    })),
    failure_code: "live_smoke_failed",
  };
  const recorded = await worker.fetch(
    request(`${inspectPath}/outcome`, { intent_digest: intent.intent_digest, outcome }),
    stagingEnv,
  );
  expect(recorded.status, await recorded.clone().text()).toBe(201);
  const terminal = await worker.fetch(request(inspectPath), stagingEnv);
  expect(terminal.status, await terminal.clone().text()).toBe(200);
  await assertHttpResponse(document, "/v1/staging-deployments/{release}", "get", terminal);
  expect(await terminal.json()).toEqual(await recorded.json());
});

// Captured through the unmodified owner HTTP handler at ebbdd7ab, with actual
// schema-37 D1 storage. These fixtures retain the acknowledged JSON and receipt.
test.each([arrayIntent, nestedIntent])(
  "retained scope $choices.release_id replays literally after its deadline",
  async (fixture) => {
    await testEnv.CATALOGUE_DB.batch(
      [`staging-intent:${fixture.choices.release_id}`, fixture.choices.idempotency_key].map((key) =>
        retainedStagingIntentStatement(testEnv.CATALOGUE_DB, {
          key,
          requestJson: fixture.request_json,
          responseJson: JSON.stringify(fixture.response),
          createdAt: fixture.response.intent.authorized_at,
        }),
      ),
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("provider unavailable");
    });
    const send = (body: Record<string, unknown>) =>
      worker.fetch(
        new Request("http://127.0.0.1:8788/v1/staging-releases", {
          method: "POST",
          headers: {
            authorization: "Bearer vitest-administration-key",
            "content-type": "application/json",
            "x-keepr-test-now": "2026-09-17T00:00:00.000Z",
          },
          body: JSON.stringify(body),
        }),
        testEnv,
      );
    const body = { ...fixture.choices, confirmation: fixture.response.confirmation };
    const replay = await send(body);
    expect(replay.status).toBe(201);
    expect(await replay.clone().json()).toEqual(fixture.response);
    await assertHttpResponse(document, "/v1/staging-releases", "post", replay);
    const changed = await send({ ...body, validation_scope: "full" });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ code: "staging_intent_conflict" });
    const fresh = await send({
      ...fixture.choices,
      release_id: fixture.choices.release_id + "-fresh",
      idempotency_key: fixture.choices.idempotency_key + "-fresh",
      prepare: true,
    });
    expect(fresh.status).toBe(422);
    expect(await fresh.json()).toMatchObject({ code: "invalid_staging_intent" });
  },
);
