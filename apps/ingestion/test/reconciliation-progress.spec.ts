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
  const pauseRequest = () =>
    request(`/v1/ingestion-runs/${run.id}/reconciliation/pause`, {
      generation: 0,
      idempotency_key: "pause-once",
    });
  const [paused, concurrentPause] = await Promise.all([pauseRequest(), pauseRequest()]);
  expect(concurrentPause).toEqual(paused);
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
  const { runReconciliationWorkflow } = await import("../src/reconciliation-workflow");
  const { testEnv } = await import("./reconciliation-helpers");
  const firstStatus = await get(`/v1/ingestion-runs/${first.id}/reconciliation`);
  // An old delivery may initialize again after its slot has a new owner.
  await runReconciliationWorkflow(
    testEnv,
    {
      payload: {
        ingestion_run_id: first.id,
        expected_current_revision_id: first.document.expected_current_revision_id,
        idempotency_key: "released-slot-replay",
        observed_at: firstStatus.document.created_at,
      },
    } as import("cloudflare:workers").WorkflowEvent<
      import("../../../src/catalogue/reconciliation").ReconciliationWorkflowParams
    >,
    {
      do: async (_name: string, _config: unknown, callback: () => Promise<string>) => callback(),
    } as unknown as import("cloudflare:workers").WorkflowStep,
  );
  expect((await get(`/v1/ingestion-runs/${second.id}/reconciliation`)).document).toMatchObject({
    state: "sealed",
    generation: 0,
  });
});

test("a terminal response from an old Workflow poll cannot pause a resumed generation", async () => {
  const { default: worker } = await import("../src/index");
  const { testEnv, post } = await import("./reconciliation-helpers");
  const run = await collect("/reconciliation/base", "stale-workflow-poll");
  let onStatus = async () => ({ status: "running" });
  const instance = { status: () => onStatus() } as unknown as WorkflowInstance;
  const workflow = {
    create: async () => instance,
    get: async () => instance,
  } as unknown as Env["RECONCILIATION_WORKFLOW"];
  const request = () =>
    worker.fetch(
      new Request(`https://card-keepr.invalid/v1/ingestion-runs/${run.id}/reconciliation`, {
        method: "POST",
        headers: { authorization: "Bearer vitest-administration-key", "content-type": "application/json" },
        body: JSON.stringify({
          expected_current_revision_id: run.document.expected_current_revision_id,
          idempotency_key: "stale-poll-start",
        }),
      }),
      { ...testEnv, RECONCILIATION_WORKFLOW: workflow },
    );
  expect((await request()).status).toBe(202);
  onStatus = async () => {
    onStatus = async () => ({ status: "running" });
    expect(
      (
        await post(`/v1/ingestion-runs/${run.id}/reconciliation/pause`, {
          generation: 0,
          idempotency_key: "stale-poll-pause",
        })
      ).response.status,
    ).toBe(200);
    const response = await worker.fetch(
      new Request(`https://card-keepr.invalid/v1/ingestion-runs/${run.id}/reconciliation/resume`, {
        method: "POST",
        headers: { authorization: "Bearer vitest-administration-key", "content-type": "application/json" },
        body: JSON.stringify({ generation: 1, idempotency_key: "stale-poll-resume" }),
      }),
      { ...testEnv, RECONCILIATION_WORKFLOW: workflow },
    );
    expect(response.status).toBe(200);
    return { status: "errored" };
  };
  const staleResponse = await request();
  expect(await staleResponse.json()).toMatchObject({ status: "running", output: null });
  expect((await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document).toMatchObject({
    state: "preparing",
    generation: 1,
  });
});

test("transient image storage failures exhaust bounded retries into a resumable pause", async () => {
  const { testEnv } = await import("./reconciliation-helpers");
  const { runReconciliationWorkflow } = await import("../src/reconciliation-workflow");
  const run = await collect("/reconciliation/base", "image-storage-outage");
  let attempts = 0;
  const unavailable = new Proxy(testEnv.PRINTING_IMAGES, {
    get(target, property) {
      if (property === "put")
        return async () => {
          attempts++;
          throw new Error("injected R2 transport outage");
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const event = {
    payload: {
      ingestion_run_id: run.id,
      expected_current_revision_id: run.document.expected_current_revision_id,
      idempotency_key: "image-storage-outage",
      observed_at: new Date().toISOString(),
    },
  } as import("cloudflare:workers").WorkflowEvent<
    import("../../../src/catalogue/reconciliation").ReconciliationWorkflowParams
  >;
  const step = {
    do: async (_name: string, config: { retries: { limit: number } }, callback: () => Promise<string>) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await callback();
        } catch (error) {
          if (attempt >= config.retries.limit) throw error;
        }
      }
    },
  } as unknown as import("cloudflare:workers").WorkflowStep;
  await runReconciliationWorkflow({ ...testEnv, PRINTING_IMAGES: unavailable }, event, step);
  expect(attempts).toBe(4);
  expect((await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document).toMatchObject({
    state: "paused",
    generation: 1,
  });
  expect((await get(`/v1/ingestion-runs/${run.id}`)).document).toMatchObject({ state: "parsing" });
});

test("interrupted preparation resumes verified batches before sealing for review", async () => {
  const { testEnv, post } = await import("./reconciliation-helpers");
  const { runReconciliationWorkflow } = await import("../src/reconciliation-workflow");
  const run = await collect("/reconciliation/base", "preparation-interruption");
  const sqlByStatement = new WeakMap<object, string>();
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    sqlByStatement.set(proxy, sql);
    return proxy;
  };
  let preparationBatches = 0;
  const database = new Proxy(testEnv.CATALOGUE_DB, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (property === "batch")
        return async (statements: D1PreparedStatement[]) => {
          if (
            statements.some((statement) =>
              sqlByStatement.get(statement)?.includes("INSERT INTO reconciliation_preparation_batches"),
            )
          ) {
            preparationBatches++;
            if (preparationBatches === 3) throw new Error("injected bounded preparation interruption");
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const payload = {
    ingestion_run_id: run.id,
    expected_current_revision_id: requiredString(run.document, "expected_current_revision_id"),
    idempotency_key: "preparation-interruption",
    observed_at: new Date().toISOString(),
    generation: 0,
  };
  const event = { payload } as import("cloudflare:workers").WorkflowEvent<
    import("../../../src/catalogue/reconciliation").ReconciliationWorkflowParams
  >;
  const step = {
    do: async (_name: string, _config: unknown, callback: () => Promise<string>) => callback(),
  } as unknown as import("cloudflare:workers").WorkflowStep;
  await runReconciliationWorkflow({ ...testEnv, CATALOGUE_DB: database }, event, step);
  expect(preparationBatches).toBe(3);
  const paused = await get(`/v1/ingestion-runs/${run.id}/reconciliation`);
  expect(paused.document).toMatchObject({
    state: "paused",
    generation: 1,
    completed_batches: 2,
    candidate_digest: null,
  });
  const inputs = await get(`/v1/ingestion-runs/${run.id}/reconciliation/inputs`);
  expect(inputs.document).toMatchObject({ verified: true, manifest_digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
  const partitions = inputs.document.partitions as { ordinal: number; kind: string; byte_length: number }[];
  expect(partitions.every((partition) => partition.byte_length <= 524288)).toBe(true);
  const observations = partitions.find((partition) => partition.kind === "observations")!;
  const inputPage = await get(`/v1/ingestion-runs/${run.id}/reconciliation/inputs/${observations.ordinal}`);
  expect(inputPage.response.status).toBe(200);
  expect(JSON.stringify(inputPage.document)).not.toContain("content_base64");

  expect((await get(`/v1/ingestion-runs/${run.id}`)).document).toMatchObject({ state: "parsing" });
  expect(
    (
      await post(`/v1/ingestion-runs/${run.id}/reconciliation/resume`, {
        generation: 1,
        idempotency_key: "preparation-resume",
      })
    ).response.status,
  ).toBe(200);
  const unavailableEvidence = new Proxy(testEnv.EVIDENCE_OBJECTS, {
    get(target, property) {
      if (property === "get")
        return async () => {
          throw new Error("Verified inputs must be reused without rereading evidence objects.");
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await runReconciliationWorkflow(
    { ...testEnv, EVIDENCE_OBJECTS: unavailableEvidence },
    { payload: { ...payload, generation: 1 } } as typeof event,
    step,
  );
  expect((await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document).toMatchObject({
    state: "sealed",
    generation: 1,
    deadline: paused.document.deadline,
    completed_batches: expect.any(Number),
  });
  expect((await get(`/v1/ingestion-runs/${run.id}`)).document).toMatchObject({ state: "awaiting_approval" });
});

test("operation initialization pins even an empty admission selection before Workflow delivery", async () => {
  const { default: worker } = await import("../src/index");
  const { testEnv } = await import("./reconciliation-helpers");
  const { runReconciliationWorkflow } = await import("../src/reconciliation-workflow");
  const run = await collect("/reconciliation/base", "early-admission-pin");
  const instance = { status: async () => ({ status: "running" }) } as unknown as WorkflowInstance;
  const workflow = {
    create: async () => instance,
    get: async () => instance,
  } as unknown as Env["RECONCILIATION_WORKFLOW"];
  const response = await worker.fetch(
    new Request(`https://card-keepr.invalid/v1/ingestion-runs/${run.id}/reconciliation`, {
      method: "POST",
      headers: { authorization: "Bearer vitest-administration-key", "content-type": "application/json" },
      body: JSON.stringify({
        expected_current_revision_id: run.document.expected_current_revision_id,
        idempotency_key: "early-admission-pin",
      }),
    }),
    { ...testEnv, RECONCILIATION_WORKFLOW: workflow },
  );
  expect(response.status).toBe(202);
  const operation = await get(`/v1/ingestion-runs/${run.id}/reconciliation`);
  expect(operation.document).toMatchObject({ admission_selection_pinned: 1, admission_decision_count: 0 });
  await runReconciliationWorkflow(
    testEnv,
    {
      payload: {
        ingestion_run_id: run.id,
        expected_current_revision_id: run.document.expected_current_revision_id,
        idempotency_key: "early-admission-pin",
        observed_at: operation.document.created_at,
      },
    } as import("cloudflare:workers").WorkflowEvent<
      import("../../../src/catalogue/reconciliation").ReconciliationWorkflowParams
    >,
    {
      do: async (_name: string, _config: unknown, callback: () => Promise<string>) => callback(),
    } as unknown as import("cloudflare:workers").WorkflowStep,
  );
  const sealed = await get(`/v1/ingestion-runs/${run.id}/reconciliation`);
  expect(sealed.document).toMatchObject({
    state: "sealed",
    admission_selection_pinned: 1,
    admission_decision_count: 0,
  });
});

test("a completed Workflow that paused durable work reports paused without requiring a sealed candidate", async () => {
  const { default: worker } = await import("../src/index");
  const { testEnv, post } = await import("./reconciliation-helpers");
  const { runReconciliationWorkflow } = await import("../src/reconciliation-workflow");
  const run = await collect("/reconciliation/base", "workflow-complete-paused");
  const unavailable = new Proxy(testEnv.PRINTING_IMAGES, {
    get(target, property) {
      if (property === "put")
        return async () => {
          throw new Error("injected R2 exhaustion");
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const step = {
    do: async (_name: string, _config: unknown, callback: () => Promise<string>) => callback(),
  } as unknown as import("cloudflare:workers").WorkflowStep;
  let instance: WorkflowInstance;
  const workflow = {
    create: async ({
      params,
    }: {
      params: import("../../../src/catalogue/reconciliation").ReconciliationWorkflowParams;
    }) => {
      const output = await runReconciliationWorkflow(
        { ...testEnv, PRINTING_IMAGES: unavailable },
        { payload: params } as import("cloudflare:workers").WorkflowEvent<typeof params>,
        step,
      );
      instance = { status: async () => ({ status: "complete", output }) } as unknown as WorkflowInstance;
      return instance;
    },
    get: async () => instance,
  } as unknown as Env["RECONCILIATION_WORKFLOW"];
  const response = await worker.fetch(
    new Request(`https://card-keepr.invalid/v1/ingestion-runs/${run.id}/reconciliation`, {
      method: "POST",
      headers: { authorization: "Bearer vitest-administration-key", "content-type": "application/json" },
      body: JSON.stringify({
        expected_current_revision_id: run.document.expected_current_revision_id,
        idempotency_key: "workflow-complete-paused",
      }),
    }),
    { ...testEnv, RECONCILIATION_WORKFLOW: workflow },
  );
  expect(await response.json()).toMatchObject({ status: "paused", output: null });
  const operation = await get(`/v1/ingestion-runs/${run.id}/reconciliation`);
  const expired = await post(
    `/v1/ingestion-runs/${run.id}/reconciliation/resume`,
    {
      generation: 1,
      idempotency_key: "resume-after-original-deadline",
    },
    { "x-keepr-test-now": new Date(Date.parse(String(operation.document.deadline)) + 1).toISOString() },
  );
  expect(expired.response.status).toBe(409);
  expect(expired.document).toMatchObject({ code: "reconciliation_deadline_expired" });
  expect((await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document).toMatchObject({
    state: "paused",
    generation: 1,
    deadline: operation.document.deadline,
  });
});
