import { applyD1Migrations, type D1Migration, env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import worker from "../src/index";
import type { CatalogueBackupWorkflowParams } from "../../../src/catalogue/backup-recovery";
import document from "../../../contracts/admin-openapi.json";
import { assertHttpResponse } from "../../../test/support/http-contract";
import { administrationPresentation } from "../../../src/http/administration-presentation.mjs";

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };
beforeEach(async () => {
  await applyD1Migrations(testEnv.CATALOGUE_DB, testEnv.TEST_MIGRATIONS);
});

function request(body: Record<string, unknown>, observedAt = "2026-09-15T01:00:00.000Z") {
  return new Request("https://card-keepr.invalid/v1/backups", {
    method: "POST",
    headers: {
      authorization: "Bearer vitest-administration-key",
      "content-type": "application/json",
      "x-keepr-test-now": observedAt,
    },
    body: JSON.stringify(body),
  });
}

// Control only the external Workflow observation. Requests, durable dispatch
// retention, replay comparison and administration guards use the real Worker/D1.
test("backup HTTP replay preserves its original intent and observes dispatch, running and terminal failure", async () => {
  const body = {
    expected_current_revision_id: "catrev_spine_000",
    idempotency_key: "owner backup / " + "x".repeat(240),
  };
  let unavailable = true;
  let status: InstanceStatus = { status: "queued" };
  const creations: WorkflowInstanceCreateOptions<CatalogueBackupWorkflowParams>[] = [];
  const unexpected = async () => {
    throw new Error("Unexpected Workflow control operation");
  };
  const instance: WorkflowInstance = {
    id: "observed-workflow",
    status: async () => {
      if (unavailable) throw new Error("Workflow observation unavailable");
      return status;
    },
    pause: unexpected,
    resume: unexpected,
    terminate: unexpected,
    restart: unexpected,
    delete: unexpected,
    sendEvent: unexpected,
  };
  const workflow: Workflow<CatalogueBackupWorkflowParams> = {
    create: async (options) => {
      if (options) creations.push(options);
      if (unavailable) throw new Error("Workflow dispatch unavailable");
      return instance;
    },
    get: async () => instance,
    createBatch: unexpected,
    deleteBatch: unexpected,
  };
  const environment = { ...testEnv, CATALOGUE_BACKUP_WORKFLOW: workflow };
  const send = (value = body) => worker.fetch(request(value), environment);
  const failed = await send();
  expect(failed.status, await failed.clone().text()).toBe(202);
  const first = await failed.json<Record<string, unknown>>();
  expect(first).toMatchObject({
    idempotency_key: body.idempotency_key,
    status: "dispatch_failed",
    output: null,
    dispatch: { state: "failed", retry: { body } },
  });
  await assertHttpResponse(document, "/v1/backups", "post", failed, first);
  unavailable = false;
  const queued = await worker.fetch(request(body, "2026-09-15T02:00:00.000Z"), environment);
  expect(queued.status).toBe(200);
  await assertHttpResponse(document, "/v1/backups", "post", queued);
  expect(await queued.json()).toMatchObject({
    workflow_instance_id: first.workflow_instance_id,
    status: "queued",
    output: null,
  });
  expect(creations.at(-1)?.params).toEqual({ ...body, observed_at: "2026-09-15T01:00:00.000Z" });
  const count = creations.length;
  status = { status: "running" };
  const running = await send();
  await assertHttpResponse(document, "/v1/backups", "post", running);
  expect(await running.json()).toMatchObject({
    workflow_instance_id: first.workflow_instance_id,
    status: "running",
    output: null,
  });
  unavailable = true;
  const unknown = await send();
  await assertHttpResponse(document, "/v1/backups", "post", unknown);
  expect(await unknown.json()).toMatchObject({
    status: "unknown",
    output: null,
    dispatch: { state: "dispatched", failure: null, retry: null },
  });
  unavailable = false;
  status = { status: "errored", error: { name: "ProviderError", message: "Retained provider failure" } };
  const completed = await send();
  expect(completed.status).toBe(200);
  const terminal = await completed.json<Record<string, unknown>>();
  expect(terminal).toMatchObject({
    workflow_instance_id: first.workflow_instance_id,
    status: "complete",
    output: {
      contract: "card-keepr-catalogue-backup-workflow-failure@1",
      code: "backup_failed",
      detail: "Retained provider failure",
    },
  });
  await assertHttpResponse(document, "/v1/backups", "post", completed, terminal);
  expect(administrationPresentation(terminal).exit_code).toBe(8);
  const changed = await send({ ...body, expected_current_revision_id: "catrev_other" });
  expect(changed.status).toBe(409);
  await assertHttpResponse(document, "/v1/backups", "post", changed);
  expect(await changed.json()).toMatchObject({ code: "idempotency_key_reused" });
  expect(creations).toHaveLength(count);
});

test("backup and recovery reject malformed commands, unsupported media and unbounded bodies before mutation", async () => {
  const send = (path: string, body: string, media = "application/json") =>
    worker.fetch(
      new Request(`https://card-keepr.invalid${path}`, {
        method: "POST",
        headers: { authorization: "Bearer vitest-administration-key", "content-type": media },
        body,
      }),
      testEnv,
    );
  const commands = [
    ["/v1/backups", '{"expected_current_revision_id":"catrev_spine_000","idempotency_key":null}', 422],
    [
      "/v1/backups",
      '{"expected_current_revision_id":"catrev_spine_000","idempotency_key":"key","failed_attempt_id":null,"failed_attempt_digest":null}',
      422,
    ],
    [
      "/v1/backups",
      '{"expected_current_revision_id":"catrev_spine_000","idempotency_key":"key","__proto__":{"literal":1}}',
      422,
    ],
    ["/v1/backups", '{"expected_current_revision_id":"catrev_spine_000","idempotency_key":"key","":0}', 422],
    ["/v1/backups", "{", 400],
    ["/v1/backups", JSON.stringify({ idempotency_key: "x".repeat(16385) }), 413],
    ["/v1/recoveries", '{"environment":"production"}', 422],
    ["/v1/recoveries/recovery/verification", '{"target_digest":"bad","idempotency_key":"verify"}', 422],
    ["/v1/recoveries/recovery/acceptance", '{"target_digest":"bad","idempotency_key":"accept"}', 422],
  ] as const;
  for (const [path, body, status] of commands) {
    const response = await send(path, body);
    expect(response.status).toBe(status);
    await assertHttpResponse(
      document,
      path.replace("/recoveries/recovery/", "/recoveries/{recovery}/"),
      "post",
      response,
    );
  }
  const unsupported = await send("/v1/backups", "{}", "text/plain");
  expect(unsupported.status).toBe(415);
  await assertHttpResponse(document, "/v1/backups", "post", unsupported);
});
