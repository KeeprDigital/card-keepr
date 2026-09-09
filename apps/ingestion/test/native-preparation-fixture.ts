import { expect } from "vitest";
import type { ReconciliationWorkflowParams } from "../../../src/catalogue/reconciliation";
import worker from "../src/index";
import { testEnv } from "./reconciliation-helpers";

/** Capture the native dispatch so the existing fault driver exclusively runs each durable unit. */
export async function retainNativePreparation(runId: string, predecessor: string, key: string) {
  let params: ReconciliationWorkflowParams | undefined;
  const queued = { status: async () => ({ status: "queued" }) } as unknown as WorkflowInstance;
  const binding = {
    create: async (options: { params: ReconciliationWorkflowParams }) => {
      params = options.params;
      return queued;
    },
    get: async () => queued,
  } as unknown as Env["RECONCILIATION_WORKFLOW"];
  const request = (path: string, body: Record<string, unknown>) =>
    worker.fetch(
      new Request(`https://card-keepr.invalid${path}`, {
        method: "POST",
        headers: { authorization: "Bearer vitest-administration-key", "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { ...testEnv, RECONCILIATION_WORKFLOW: binding },
    );
  const created = await request("/v1/game-candidates", {
    ingestion_run_id: runId,
    supported_game: "one-piece",
    expected_game_revision_id: predecessor,
    idempotency_key: key,
  });
  expect(created.status).toBe(201);
  const header = await created.json<Record<string, unknown>>();
  expect(params).toBeDefined();
  expect(params?.preparation_id).toBe(header.id);
  return {
    candidateId: String(header.id),
    params: params!,
    resume: (generation: number, idempotencyKey: string) =>
      request(`/v1/game-candidates/${header.id}/resume`, { generation, idempotency_key: idempotencyKey }),
  };
}
