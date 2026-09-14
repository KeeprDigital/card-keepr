import { applyD1Migrations, type D1Migration, env } from "cloudflare:test";
import { beforeEach, afterEach, expect, test, vi } from "vitest";
import worker from "../src/index";

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };
beforeEach(async () => {
  await applyD1Migrations(testEnv.CATALOGUE_DB, testEnv.TEST_MIGRATIONS);
});
afterEach(() => vi.restoreAllMocks());

test("owner HTTP intent requires administration auth and replays without a fresh provider dependency", async () => {
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
    release_id: "stage-http",
    idempotency_key: "stage-http-owner",
    expected_head_sha: "a".repeat(40),
    expected_actor: "owner",
    ci_run_id: "123",
    validation_scope: "auto",
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
  const { confirmation } = await preview.json<{ confirmation: string }>();
  const accepted = await worker.fetch(request("/v1/staging-releases", { ...choices, confirmation }), testEnv);
  expect(accepted.status).toBe(201);
  const intent = await accepted.json<{ intent_digest: string; intent: Record<string, unknown> }>();
  expect(intent.intent).toMatchObject({ validation_scope: "full", validation_reason: "unknown_transition" });
  provider.mockImplementation(async () => {
    throw new Error("provider unavailable after accepted owner request");
  });
  const replay = await worker.fetch(request("/v1/staging-releases", { ...choices, confirmation }), testEnv);
  expect(replay.status).toBe(201);
  expect(await replay.json()).toEqual(intent);
  const status = await worker.fetch(request("/v1/staging-releases/stage-http"), testEnv);
  expect(status.status).toBe(200);
  expect(await status.json()).toMatchObject({ ...intent, authorization: null });
  const wrongAuthority = await worker.fetch(
    request("/v1/staging-release-authorizations", { release_id: "stage-http", intent_digest: intent.intent_digest }),
    testEnv,
  );
  expect(wrongAuthority.status).toBe(403);
  expect(await wrongAuthority.json()).toMatchObject({ code: "invalid_staging_workflow_attestation" });
  expect((await worker.fetch(request("/v1/staging-deployments/stage-http"), testEnv)).status).toBe(404);
});
