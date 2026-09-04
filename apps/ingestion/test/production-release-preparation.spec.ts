import { applyD1Migrations, type D1Migration, env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import worker from "../src/index";
import { preparedReleaseCount, seedUnrelatedAdministrationKey } from "./query-helpers/release-preparation";

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };
beforeEach(async () => {
  await applyD1Migrations(testEnv.CATALOGUE_DB, testEnv.TEST_MIGRATIONS);
});
async function request(body: Record<string, unknown>) {
  return worker.fetch(
    new Request("http://127.0.0.1:8788/v1/production-releases", {
      method: "POST",
      headers: { authorization: "Bearer vitest-administration-key", "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    testEnv,
  );
}
const intent = {
  release_id: "release_thin_cli",
  idempotency_key: "release_thin_cli_prepare",
  expected_current_revision_id: "catrev_spine_000",
  expected_head_sha: "a".repeat(40),
  expected_actor: "keepr-release[bot]",
  expected_migration_level: 12,
  bootstrap: true,
  replacement_handoff: null,
};
test("release preparation resolves confirmation without mutation and returns server-issued dispatch bytes", async () => {
  const preview = await request({ ...intent, prepare: true });
  expect(preview.status).toBe(200);
  const resolved = await preview.json<Record<string, unknown>>();
  expect(resolved).toMatchObject({
    contract: "card-keepr-production-release-confirmation@1",
    release_id: intent.release_id,
  });
  expect(typeof resolved.confirmation).toBe("string");
  expect(await preparedReleaseCount(testEnv.CATALOGUE_DB).first("count")).toBe(0);
  const unconfirmed = await request({ ...intent, confirmation: "incorrect" });
  expect(unconfirmed.status).toBe(409);
  expect(await preparedReleaseCount(testEnv.CATALOGUE_DB).first("count")).toBe(0);
  const accepted = await request({ ...intent, confirmation: resolved.confirmation });
  expect(accepted.status).toBe(201);
  const document = await accepted.json<Record<string, unknown>>();
  expect(document).toMatchObject({
    contract: "card-keepr-production-release-request@1",
    release_id: intent.release_id,
    state: "requested",
  });
  expect(typeof document.prepared_plan_json).toBe("string");
  const inputs = document.dispatch_inputs as Record<string, string>;
  expect(inputs.prepared_plan_json).toBe(document.prepared_plan_json);
  expect(inputs.dispatch_digest).toBe(document.dispatch_digest);
  const bytes = new TextEncoder().encode(document.prepared_plan_json as string);
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  expect(document.dispatch_digest).toBe(digest);
  expect(inputs.production_target_digest).toMatch(/^[0-9a-f]{64}$/);
  const replay = await request({ ...intent, confirmation: resolved.confirmation });
  expect(await replay.json()).toEqual(document);
  expect(await preparedReleaseCount(testEnv.CATALOGUE_DB).first("count")).toBe(1);
  const reused = await request({ ...intent, expected_head_sha: "b".repeat(40), confirmation: resolved.confirmation });
  expect(reused.status).toBe(409);
  expect(await reused.json()).toMatchObject({ code: "idempotency_key_reused" });
});

test("administration presentation is negotiated without changing the JSON document", async () => {
  const url = "http://127.0.0.1:8788/v1/status";
  const headers = { authorization: "Bearer vitest-administration-key", accept: "application/vnd.card-keepr.cli+json" };
  const response = await worker.fetch(new Request(url, { headers }), testEnv);
  expect(response.status).toBe(200);
  expect(response.headers.get("vary")).toBe("Accept");
  const presentation = await response.json<Record<string, unknown>>();
  expect(presentation.contract).toBe("card-keepr-cli-presentation@1");
  expect(presentation.document).toMatchObject({ contract: "card-keepr-administration-status@1" });
  expect(presentation.exit_code).toBe(0);
  expect(typeof presentation.text).toBe("string");
});

test("another operation's idempotency record is rejected before interpreting its request", async () => {
  const idempotency_key = "release_other_operation";
  await seedUnrelatedAdministrationKey(testEnv.CATALOGUE_DB, idempotency_key).run();
  const response = await request({ ...intent, idempotency_key, prepare: true });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "idempotency_key_reused" });
});
test("status resolves exact production targets without accepting stale revisions or open query fields", async () => {
  const get = (query: string) =>
    worker.fetch(
      new Request(`http://127.0.0.1:8788/v1/status?${query}`, {
        headers: { authorization: "Bearer vitest-administration-key" },
      }),
      testEnv,
    );
  const current = await get("expected_current_revision_id=catrev_spine_000");
  expect(current.status).toBe(200);
  const document = await current.json<Record<string, unknown>>();
  expect(document.resolved_target).toEqual({
    production_target: document.production_target,
    confirmation: JSON.stringify(document.production_target),
  });
  const stale = await get("expected_current_revision_id=catrev_stale");
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ code: "production_target_mismatch" });
  const unsupported = await get("expected_current_revision_id=catrev_spine_000&arbitrary_choice=true");
  expect(unsupported.status).toBe(422);
  const unretained = await get("expected_current_revision_id=catrev_spine_000&repair_revision_id=catrev_unknown");
  expect(unretained.status).toBe(409);
  expect(await unretained.json()).toMatchObject({ code: "production_target_mismatch" });
});

test("the Worker owns release actor validation before dispatch", async () => {
  const response = await request({
    ...intent,
    idempotency_key: "release_invalid_actor",
    expected_actor: `${"a".repeat(40)}[bot]`,
    prepare: true,
  });
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({ code: "invalid_production_release_request" });
});
