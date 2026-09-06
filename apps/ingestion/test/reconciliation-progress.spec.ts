import { expect, test } from "vitest";
import { collect, get, installReconciliationSuite, reconcile, requiredString } from "./reconciliation-helpers";

installReconciliationSuite();

test("owner can inspect the durable reconciliation identity and sealed progress independently of Workflow history", async () => {
  const run = await collect("/reconciliation/base", "durable-reconciliation-status");
  const result = await reconcile(run.id);
  expect(result.response.status).toBe(200);
  const status = await get(`/v1/ingestion-runs/${run.id}/reconciliation`);
  expect(status.response.status).toBe(200);
  expect(status.document).toMatchObject({
    contract: "card-keepr-reconciliation-status@1",
    ingestion_run_id: run.id,
    reconciliation_id: expect.any(String),
    state: "sealed",
    generation: 0,
    candidate_digest: requiredString(result.document, "candidate_digest"),
    created_at: expect.any(String),
    deadline: expect.any(String),
  });
  expect(
    Date.parse(requiredString(status.document, "deadline")) - Date.parse(requiredString(status.document, "created_at")),
  ).toBe(604800000);
});

test("sealed candidate records have independently inspectable integrity-bound partitions", async () => {
  const run = await collect("/reconciliation/base", "durable-reconciliation-partitions");
  const result = await reconcile(run.id);
  expect(result.response.status).toBe(200);
  const page = await get(`/v1/ingestion-runs/${run.id}/reconciliation/partitions`);
  expect(page.response.status).toBe(200);
  expect(page.document).toMatchObject({
    contract: "card-keepr-candidate-partitions@1",
    ingestion_run_id: run.id,
    sealed: true,
    partitions: expect.arrayContaining([
      expect.objectContaining({
        kind: "cards",
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        record_count: 1,
      }),
    ]),
  });
});

test("candidate image partitions retain immutable image references without embedded binary payloads", async () => {
  const run = await collect("/reconciliation/base", "candidate-image-reference");
  const result = await reconcile(run.id);
  expect(result.response.status).toBe(200);
  let cursor: string | null = null;
  const images: unknown[] = [];
  do {
    const page = await get(
      `/v1/ingestion-runs/${run.id}/reconciliation/partitions${cursor === null ? "" : `?after=${cursor}`}`,
    );
    for (const partition of page.document.partitions as { kind: string; ordinal: number }[]) {
      if (partition.kind === "printing_images") {
        const detail = await get(`/v1/ingestion-runs/${run.id}/reconciliation/partitions/${partition.ordinal}`);
        images.push(...(detail.document.records as unknown[]));
      }
    }
    cursor = page.document.next_cursor as string | null;
  } while (cursor !== null);
  expect(images.length).toBeGreaterThan(0);
  expect(images[0]).toMatchObject({
    object_key: expect.stringMatching(/^printing-images\//),
    content_sha256: expect.any(String),
    content_byte_length: expect.any(Number),
  });
  expect(JSON.stringify(images)).not.toContain("content_base64");
});

test("owner pause fences the prior generation and exact resume preserves identity and deadline", async () => {
  const { default: worker } = await import("../src/index");
  const { testEnv } = await import("./reconciliation-helpers");
  const run = await collect("/reconciliation/base", "pause-reconciliation");
  const instance = { status: async () => ({ status: "running" }) } as unknown as WorkflowInstance;
  const workflow = {
    create: async () => instance,
    get: async () => instance,
  } as unknown as Env["RECONCILIATION_WORKFLOW"];
  const request = async (path: string, body: object) => {
    const response = await worker.fetch(
      new Request(`https://card-keepr.invalid${path}`, {
        method: "POST",
        headers: { authorization: "Bearer vitest-administration-key", "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { ...testEnv, RECONCILIATION_WORKFLOW: workflow },
    );
    return { status: response.status, document: await response.json<Record<string, unknown>>() };
  };
  await request(`/v1/ingestion-runs/${run.id}/reconciliation`, {
    expected_current_revision_id: run.document.expected_current_revision_id,
    idempotency_key: "pause-start",
  });
  const before = await get(`/v1/ingestion-runs/${run.id}/reconciliation`);
  const paused = await request(`/v1/ingestion-runs/${run.id}/reconciliation/pause`, {
    generation: 0,
    idempotency_key: "pause-once",
  });
  expect(paused.status).toBe(200);
  expect(paused.document).toMatchObject({ state: "paused", generation: 1 });
  const resumeBody = { generation: 1, idempotency_key: "resume-once" };
  const resumed = await request(`/v1/ingestion-runs/${run.id}/reconciliation/resume`, resumeBody);
  expect(resumed.status).toBe(200);
  expect(resumed.document).toMatchObject({
    state: "preparing",
    generation: 1,
    reconciliation_id: before.document.reconciliation_id,
    deadline: before.document.deadline,
  });
  const replay = await request(`/v1/ingestion-runs/${run.id}/reconciliation/resume`, resumeBody);
  expect(replay.document).toEqual(resumed.document);
  const stale = await request(`/v1/ingestion-runs/${run.id}/reconciliation/pause`, {
    generation: 0,
    idempotency_key: "stale-pause",
  });
  expect(stale.status).toBe(409);
  // Inject an old and then a current delivery at the external Workflow boundary;
  // observe the outcome only through owner administration.
  const { runReconciliationWorkflow } = await import("../src/reconciliation-workflow");
  const step = {
    do: async (_name: string, _config: unknown, callback: () => Promise<string>) => callback(),
  } as unknown as import("cloudflare:workers").WorkflowStep;
  const event = (generation: number) =>
    ({
      payload: {
        ingestion_run_id: run.id,
        expected_current_revision_id: run.document.expected_current_revision_id,
        idempotency_key: "pause-start",
        observed_at: before.document.created_at,
        generation,
      },
    }) as import("cloudflare:workers").WorkflowEvent<
      import("../../../src/catalogue/reconciliation").ReconciliationWorkflowParams
    >;
  await runReconciliationWorkflow(testEnv, event(0), step);
  expect((await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document).toMatchObject({
    state: "preparing",
    generation: 1,
  });
  await runReconciliationWorkflow(testEnv, event(1), step);
  expect((await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document).toMatchObject({
    state: "sealed",
    generation: 1,
    deadline: before.document.deadline,
  });
});

test("collection can continue while the same game's candidate slot stays serialized", async () => {
  const { post } = await import("./reconciliation-helpers");
  const first = await collect("/reconciliation/base", "candidate-slot-first");
  const second = await collect("/reconciliation/new-locator", "candidate-slot-second");
  const sealed = await reconcile(first.id);
  expect(sealed.response.status).toBe(200);
  const waiting = await reconcile(second.id);
  expect(waiting.response.status).toBe(409);
  expect(waiting.document).toMatchObject({ code: "game_candidate_slot_occupied" });
  await post(`/v1/ingestion-runs/${first.id}/rejection`, {
    candidate_digest: sealed.document.candidate_digest,
    idempotency_key: "release-game-slot",
  });
  expect((await reconcile(second.id)).response.status).toBe(200);
});
