import { retainReconciliationCheckpoint } from "../../../src/catalogue/reconciliation/reconciliation-checkpoint";
import { expect, test } from "vitest";
import worker from "../src/index";
import document from "../../../contracts/admin-openapi.json";
import { assertHttpResponse } from "../../../test/support/http-contract";
import { changeReconciliationProgress } from "../../../src/catalogue/reconciliation/reconciliation-progress";
import { catalogueStore } from "../../../src/catalogue/shared";
import { collect, installReconciliationSuite, testEnv } from "./reconciliation-helpers";

installReconciliationSuite();

test("retained reconciliation observes current Workflow status while replaying original numeric action receipts", async () => {
  const run = await collect("/reconciliation/base", "retained-http-actions");
  const instance = { status: async () => ({ status: "running" }) } as unknown as WorkflowInstance;
  const workflow = {
    create: async () => instance,
    get: async () => instance,
  } as unknown as Env["RECONCILIATION_WORKFLOW"];
  const send = async (suffix: string, body?: object, at?: string) => {
    const path = `/v1/ingestion-runs/${run.id}/reconciliation${suffix}`;
    const response = await worker.fetch(
      new Request(`https://card-keepr.invalid${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          authorization: "Bearer vitest-administration-key",
          "content-type": "application/json",
          ...(at ? { "x-keepr-test-now": at } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
      { ...testEnv, RECONCILIATION_WORKFLOW: workflow },
    );
    await assertHttpResponse(
      document,
      `/v1/ingestion-runs/{run}/reconciliation${suffix}`,
      body ? "post" : "get",
      response,
    );
    return { status: response.status, body: await response.json<Record<string, unknown>>() };
  };
  const command = {
    expected_current_revision_id: run.document.expected_current_revision_id,
    idempotency_key: "retained-start",
  };
  const started = await send("", command);
  expect(started.status).toBe(202);
  expect(started.body).toMatchObject({ status: "running", output: null });
  const retainedCursor = JSON.parse('{"after":null,"__proto__":{"historical":"literal"},"":0}');
  await retainReconciliationCheckpoint(
    catalogueStore(testEnv.CATALOGUE_DB),
    run.id,
    "input_preparation",
    0,
    retainedCursor,
  );
  const initial = await send("");
  expect(initial.body.checkpoints).toEqual([expect.objectContaining({ cursor: retainedCursor })]);
  expect(initial.body).toMatchObject({
    state: "preparing",
    generation: 0,
    admission_selection_pinned: 1,
    candidate_digest: null,
    manifest_digest: null,
  });
  expect(typeof initial.body.definition_pins_json).toBe("string");
  const pause = { generation: 0, idempotency_key: "retained-pause" };
  const paused = await send("/pause", pause);
  expect(paused.body).toMatchObject({ state: "paused", generation: 1, deadline: initial.body.deadline });
  // Historical routes converted the wire string with Number before storing intent.
  // Prepare that exact retained domain decision, then replay it through numeric HTTP.
  const resume = { generation: Number("01"), idempotency_key: "historical-numeric-resume" };
  const originalResume = await changeReconciliationProgress(
    catalogueStore(testEnv.CATALOGUE_DB),
    run.id,
    "resume",
    resume,
  );
  expect((await send("/resume", resume)).body).toEqual(originalResume);
  await send("/pause", { generation: 1, idempotency_key: "retained-pause-again" });
  const afterDeadline = new Date(Date.parse(String(initial.body.deadline)) + 1).toISOString();
  expect((await send("/resume", resume, afterDeadline)).body).toEqual(originalResume);
  expect((await send("/pause", pause, afterDeadline)).body).toEqual(paused.body);
  expect((await send("", command)).body).toMatchObject({
    status: "paused",
    output: null,
    workflow_instance_id: started.body.workflow_instance_id,
  });
  expect((await send("")).body).toMatchObject({ state: "paused", generation: 2 });
  const stale = await send("/resume", { generation: 1, idempotency_key: "fresh-stale" });
  expect(stale.status).toBe(409);
  const abandoned = await send("/abandon", { generation: 2, idempotency_key: "retained-abandon" });
  expect(abandoned.body).toMatchObject({ state: "abandoned", generation: 3, deadline: initial.body.deadline });
  expect((await send("", command)).body).toMatchObject({ status: "abandoned", output: null });
});
