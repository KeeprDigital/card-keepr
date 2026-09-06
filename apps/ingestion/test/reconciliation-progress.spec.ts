import { expect, test } from "vitest";
import { collect, get, installReconciliationSuite, reconcile, requiredString } from "./reconciliation-helpers";

installReconciliationSuite();

test("game predecessor follows pinned ancestry despite publication clock skew", async () => {
  const { post } = await import("./reconciliation-helpers");
  const revisions: string[] = [];
  const now = Date.now();
  for (const [index, scenario] of ["query-hot-window-1", "query-hot-window-2"].entries()) {
    const run = await collect(`/reconciliation/${scenario}`, `game-predecessor-${index}`);
    const result = await reconcile(run.id);
    expect(result.response.status).toBe(200);
    const published = await post(
      `/v1/ingestion-runs/${run.id}/approval`,
      {
        candidate_digest: result.document.candidate_digest,
        expected_current_revision_id: result.document.expected_current_revision_id,
        idempotency_key: `game-predecessor-approve-${index}`,
      },
      { "x-keepr-test-now": new Date(now + (2 - index) * 60000).toISOString() },
    );
    expect(published.response.status).toBe(200);
    revisions.push(requiredString(published.document, "resulting_revision_id"));
  }
  expect(revisions[0]).not.toBe(revisions[1]);
  const next = await collect("/reconciliation/query-hot-window-3", "game-predecessor-next");
  expect((await reconcile(next.id)).response.status).toBe(200);
  const status = await get(`/v1/ingestion-runs/${next.id}/reconciliation`);
  expect(status.document.candidates).toEqual([expect.objectContaining({ expected_game_revision_id: revisions[1] })]);
});

test("one collection exposes separate sealed game manifests containing only each game's records", async () => {
  const { administrationRequest, resumeCollection, waitForEvidenceRun } = await import("./runtime-helpers");
  const started = await administrationRequest("/v1/ingestion-runs/evidence", "POST", {
    idempotency_key: "separate-game-manifests",
    plans: [
      {
        supported_game: "one-piece",
        source_lineage: "one-piece-en",
        adapter_version: "fixture-one-piece-json@3",
        requests: [
          { id: "one-piece-en:discovery", url: "https://official-source.invalid/reconciliation/game-scoped-warning" },
        ],
      },
      {
        supported_game: "fusion-world",
        source_lineage: "fusion-world-en",
        adapter_version: "fixture-fusion-world-json@2",
        requests: [
          {
            id: "fusion-world-en:discovery",
            url: "https://official-source.invalid/reconciliation/profile-fusion-world",
          },
        ],
      },
    ],
  });
  expect(started.status).toBe(201);
  const { id } = await started.json<{ id: string }>();
  await resumeCollection(id);
  await waitForEvidenceRun(id, "awaiting_approval");
  const status = await get(`/v1/ingestion-runs/${id}/reconciliation`);
  const candidates = status.document.candidates as { id: string; supported_game: string; manifest_digest: string }[];
  expect(candidates.map((candidate) => candidate.supported_game)).toEqual(["fusion-world", "one-piece"]);
  expect(new Set(candidates.map((candidate) => candidate.manifest_digest)).size).toBe(2);
  for (const candidate of candidates) {
    const header = await get(`/v1/game-candidates/${candidate.id}`);
    expect(header.response.status).toBe(200);
    expect(header.document).toMatchObject({ state: "sealed", deadline: status.document.deadline });
    const page = await get(`/v1/game-candidates/${candidate.id}/partitions`);
    expect(page.response.status).toBe(200);
    const records: Record<string, Record<string, unknown>[]> = {};
    for (const partition of page.document.partitions as { kind: string; ordinal: number }[]) {
      const detail = await get(`/v1/game-candidates/${candidate.id}/partitions/${partition.ordinal}`);
      expect(detail.response.status).toBe(200);
      records[partition.kind] = detail.document.records as Record<string, unknown>[];
    }
    expect(records.cards!.length).toBeGreaterThan(0);
    expect(records.cards!.every((card) => card.game === candidate.supported_game)).toBe(true);
    expect(records.printings!.length).toBeGreaterThan(0);
    expect(records.printings!.every((printing) => records.cards!.some((card) => card.id === printing.card_id))).toBe(
      true,
    );
    expect(records.printing_images!.length).toBeGreaterThan(0);
    expect(
      records.printing_images!.every((image) =>
        records.printings!.some((printing) => printing.id === image.printing_id),
      ),
    ).toBe(true);
    expect(records.selected_games).toEqual([candidate.supported_game]);
    if (candidate.supported_game === "one-piece")
      expect(records.warnings).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: "unknown_source_field" })]),
      );
    else expect(records.warnings ?? []).toEqual([]);
  }
});

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
  expect(status.document.candidates).toEqual([
    expect.objectContaining({
      id: expect.any(String),
      ingestion_run_id: run.id,
      supported_game: "one-piece",
      expected_game_revision_id: run.document.expected_current_revision_id,
      state: "sealed",
      deadline: status.document.deadline,
      manifest_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    }),
  ]);
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

test("verified source documents survive a later read outage and resume without rereading completed documents", async () => {
  const { testEnv, collectRequests, post } = await import("./reconciliation-helpers");
  const { runReconciliationWorkflow } = await import("../src/reconciliation-workflow");
  const run = await collectRequests(
    [
      { id: "first", scenario: "base" },
      { id: "second", scenario: "base" },
    ],
    "verified-document-resume",
  );
  let firstKey: string | null = null;
  let firstReads = 0;
  let failedReads = 0;
  let resumed = false;
  const bucket = new Proxy(testEnv.EVIDENCE_OBJECTS, {
    get(target, property) {
      if (property === "get")
        return async (key: string) => {
          if (key.startsWith("source-observations/")) {
            firstKey ??= key;
            if (key === firstKey) {
              firstReads++;
              if (resumed) throw new Error("Completed document must be reused from durable verification.");
            } else if (!resumed) {
              failedReads++;
              throw new Error("Injected source document transport outage");
            }
          }
          return target.get(key);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const payload = {
    ingestion_run_id: run.id,
    expected_current_revision_id: requiredString(run.document, "expected_current_revision_id"),
    idempotency_key: "verified-document-resume",
    observed_at: new Date().toISOString(),
    generation: 0,
  };
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
  const event = { payload } as import("cloudflare:workers").WorkflowEvent<
    import("../../../src/catalogue/reconciliation").ReconciliationWorkflowParams
  >;
  await runReconciliationWorkflow({ ...testEnv, EVIDENCE_OBJECTS: bucket }, event, step);
  expect(firstReads).toBe(1);
  expect(failedReads).toBe(4);
  const paused = await get(`/v1/ingestion-runs/${run.id}/reconciliation`);
  expect(paused.document).toMatchObject({ state: "paused", generation: 1, completed_documents: 1 });
  expect(
    (
      await post(`/v1/ingestion-runs/${run.id}/reconciliation/resume`, {
        generation: 1,
        idempotency_key: "resume-verified-documents",
      })
    ).response.status,
  ).toBe(200);
  resumed = true;
  await runReconciliationWorkflow(
    { ...testEnv, EVIDENCE_OBJECTS: bucket },
    { payload: { ...payload, generation: 1 } } as typeof event,
    step,
  );
  expect(firstReads).toBe(1);
  expect((await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document).toMatchObject({
    state: "sealed",
    generation: 1,
    deadline: paused.document.deadline,
    completed_documents: 2,
  });
});

test("normalization resumes after its last retained observation without repeating image work", async () => {
  const { testEnv, post } = await import("./reconciliation-helpers");
  const { runReconciliationWorkflow } = await import("../src/reconciliation-workflow");
  const run = await collect("/reconciliation/deterministic-forward", "normalized-observation-resume");
  let firstKey: string | null = null;
  let firstWrites = 0;
  let failedWrites = 0;
  let resumed = false;
  const images = new Proxy(testEnv.PRINTING_IMAGES, {
    get(target, property) {
      if (property === "put")
        return async (...args: Parameters<R2Bucket["put"]>) => {
          firstKey ??= args[0];
          if (args[0] === firstKey) {
            firstWrites++;
            if (resumed) throw new Error("Completed observation must not repeat image work.");
          } else if (!resumed) {
            failedWrites++;
            throw new Error("Injected second observation image outage");
          }
          return target.put(...args);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const payload = {
    ingestion_run_id: run.id,
    expected_current_revision_id: requiredString(run.document, "expected_current_revision_id"),
    idempotency_key: "normalized-observation-resume",
    observed_at: new Date().toISOString(),
    generation: 0,
  };
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
  const event = { payload } as import("cloudflare:workers").WorkflowEvent<
    import("../../../src/catalogue/reconciliation").ReconciliationWorkflowParams
  >;
  await runReconciliationWorkflow({ ...testEnv, PRINTING_IMAGES: images }, event, step);
  expect(firstWrites).toBe(1);
  expect(failedWrites).toBe(4);
  expect((await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document).toMatchObject({
    state: "paused",
    completed_observations: 1,
  });
  expect(
    (
      await post(`/v1/ingestion-runs/${run.id}/reconciliation/resume`, {
        generation: 1,
        idempotency_key: "resume-normalization",
      })
    ).response.status,
  ).toBe(200);
  resumed = true;
  await runReconciliationWorkflow(
    { ...testEnv, PRINTING_IMAGES: images },
    { payload: { ...payload, generation: 1 } } as typeof event,
    step,
  );
  expect(firstWrites).toBe(1);
  expect((await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document).toMatchObject({
    state: "sealed",
    completed_observations: 2,
  });
  expect((await get(`/v1/ingestion-runs/${run.id}/candidate`)).document).toMatchObject({
    diff: { summary: { cards_added: 1, printings_added: 2 } },
  });
});

test.each(["base", "deterministic-forward", "deterministic-reverse"])(
  "a Product-pass read outage pauses and replays %s observation effects",
  async (fixture) => {
    const { testEnv, post } = await import("./reconciliation-helpers");
    const { runReconciliationWorkflow } = await import("../src/reconciliation-workflow");
    const run = await collect(`/reconciliation/${fixture}`, "product-pass-read-outage");
    let passes = 0;
    let failures = 0;
    let unavailable = true;
    let replayingSealed = false;
    const wrap = (statement: D1PreparedStatement, sql: string, values: unknown[] = []): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, property) {
          if (property === "bind") return (...bindings: unknown[]) => wrap(target.bind(...bindings), sql, bindings);
          if (property === "first")
            return async (...args: Parameters<D1PreparedStatement["first"]>) => {
              if (
                sql.includes("FROM reconciliation_input_partitions") &&
                sql.includes("kind = ?") &&
                values.includes("observations") &&
                values.at(-1) === -1
              ) {
                passes++;
                if (unavailable && passes % 3 === 0) {
                  failures++;
                  throw new Error("Injected Product-pass input storage outage");
                }
              }
              return target.first(...args);
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    const database = new Proxy(testEnv.CATALOGUE_DB, {
      get(target, property) {
        if (property === "prepare")
          return (sql: string) => {
            if (replayingSealed && sql.includes("reconciliation_payload_chunks"))
              throw new Error("Sealed Workflow replay must use the retained candidate reference.");
            return wrap(target.prepare(sql), sql);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const payload = {
      ingestion_run_id: run.id,
      expected_current_revision_id: requiredString(run.document, "expected_current_revision_id"),
      idempotency_key: "product-pass-read-outage",
      observed_at: new Date().toISOString(),
      generation: 0,
    };
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
    const event = { payload } as import("cloudflare:workers").WorkflowEvent<
      import("../../../src/catalogue/reconciliation").ReconciliationWorkflowParams
    >;
    await runReconciliationWorkflow({ ...testEnv, CATALOGUE_DB: database }, event, step);
    expect(failures).toBe(4);
    const paused = (await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document;
    expect(paused).toMatchObject({ state: "paused", generation: 1, candidate_digest: null });
    expect(paused.completed_reducer_records).toBeGreaterThan(0);
    expect((await get(`/v1/ingestion-runs/${run.id}`)).document.state).toBe("parsing");
    expect(
      (
        await post(`/v1/ingestion-runs/${run.id}/reconciliation/resume`, {
          generation: 1,
          idempotency_key: "resume-product-read",
        })
      ).response.status,
    ).toBe(200);
    unavailable = false;
    await runReconciliationWorkflow(
      { ...testEnv, CATALOGUE_DB: database },
      { payload: { ...payload, generation: 1 } } as typeof event,
      step,
    );
    const sealed = (await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document;
    expect(sealed).toMatchObject({ state: "sealed", generation: 1 });
    expect(Number(sealed.completed_reducer_records)).toBeGreaterThan(Number(paused.completed_reducer_records));
    replayingSealed = true;
    await runReconciliationWorkflow(
      { ...testEnv, CATALOGUE_DB: database },
      { payload: { ...payload, generation: 1 } } as typeof event,
      step,
    );
    expect((await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document).toMatchObject({
      state: "sealed",
      generation: 1,
      completed_reducer_records: sealed.completed_reducer_records,
    });
  },
);

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

test("a high degree metadata record produces an explicit terminal capacity result", async () => {
  const run = await collect("/reconciliation/capacity-high-degree-observation", "explicit-capacity-result");
  const result = await reconcile(run.id);
  expect(result.response.status).toBe(409);
  expect(result.document).toMatchObject({
    state: "failed",
    diagnostics: expect.arrayContaining([expect.objectContaining({ code: "reconciliation_capacity_exceeded" })]),
  });
  expect((await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document).toMatchObject({
    state: "failed",
    failure_code: "reconciliation_capacity_exceeded",
  });
});

test("oversized warning text stays inspectable through bounded immutable text chunks", async () => {
  const run = await collect("/reconciliation/capacity-single-observation", "partitioned-warning-text");
  expect((await reconcile(run.id)).response.status).toBe(200);
  const page = await get(`/v1/ingestion-runs/${run.id}/reconciliation/partitions`);
  const partition = (page.document.partitions as { ordinal: number; kind: string }[]).find(
    (record) => record.kind === "warnings",
  )!;
  const detail = await get(`/v1/ingestion-runs/${run.id}/reconciliation/partitions/${partition.ordinal}`);
  const parts = detail.document.text_parts as {
    path: string[];
    sha256: string;
    chunks: number;
    byte_length: number;
  }[][];
  const part = parts.flat().find((reference) => reference.byte_length > 600000)!;
  expect(part).toBeDefined();
  let restored = "";
  for (let ordinal = 0; ordinal < part.chunks; ordinal++) {
    const chunk = await get(`/v1/ingestion-runs/${run.id}/reconciliation/text/${part.sha256}/${ordinal}`);
    expect(chunk.response.status).toBe(200);
    const content = requiredString(chunk.document, "content");
    expect(new TextEncoder().encode(content).byteLength).toBeLessThanOrEqual(131072);
    restored += content;
  }
  expect(new TextEncoder().encode(restored).byteLength).toBe(part.byte_length);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(restored));
  expect(Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")).toBe(part.sha256);
});

test("a retained Printing Image read outage preserves preparation for owner resume", async () => {
  const { post, testEnv, waitForRunState } = await import("./reconciliation-helpers");
  const { officialSourceDiscoveryRequests } = await import("../../../src/catalogue/adapters");
  const { collectFixtureEvidence } = await import("../../../test/support/fixture-evidence-plan");
  const { runReconciliationWorkflow } = await import("../src/reconciliation-workflow");
  const started = await post("/v1/ingestion-runs/evidence", {
    supported_game: "digimon",
    source_lineage: "digimon-en",
    adapter_version: "digimon-en@7",
    idempotency_key: "retained-image-outage",
    requests: officialSourceDiscoveryRequests("digimon-en").map((request) => ({
      ...request,
      headers: { ...request.headers, "user-agent": "card-keepr-artwork-digest-base" },
    })),
  });
  expect(started.response.status).toBe(201);
  const id = requiredString(started.document, "id");
  await collectFixtureEvidence(testEnv.CATALOGUE_DB, testEnv.EVIDENCE_OBJECTS, testEnv.OFFICIAL_SOURCE_TRANSPORT, id);
  await waitForRunState(id, "parsing");
  let unavailable = true;
  let failures = 0;
  const objects = new Proxy(testEnv.EVIDENCE_OBJECTS, {
    get(target, property) {
      if (property === "get")
        return async (...args: Parameters<R2Bucket["get"]>) => {
          const object = await target.get(...args);
          if (unavailable && object?.httpMetadata?.contentType?.startsWith("image/")) {
            failures++;
            throw new Error("Injected retained image read outage");
          }
          return object;
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
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
  const payload = {
    ingestion_run_id: id,
    expected_current_revision_id: requiredString(started.document, "expected_current_revision_id"),
    idempotency_key: "retained-image-outage",
    observed_at: new Date().toISOString(),
    generation: 0,
  };
  const event = { payload } as import("cloudflare:workers").WorkflowEvent<
    import("../../../src/catalogue/reconciliation").ReconciliationWorkflowParams
  >;
  await runReconciliationWorkflow({ ...testEnv, EVIDENCE_OBJECTS: objects }, event, step);
  expect(failures, JSON.stringify((await get(`/v1/ingestion-runs/${id}/candidate`)).document)).toBe(4);
  expect((await get(`/v1/ingestion-runs/${id}/reconciliation`)).document).toMatchObject({
    state: "paused",
    generation: 1,
  });
  expect(
    (
      await post(`/v1/ingestion-runs/${id}/reconciliation/resume`, {
        generation: 1,
        idempotency_key: "resume-retained-image",
      })
    ).response.status,
  ).toBe(200);
  unavailable = false;
  await runReconciliationWorkflow(
    { ...testEnv, EVIDENCE_OBJECTS: objects },
    { payload: { ...payload, generation: 1 } } as typeof event,
    step,
  );
  expect((await get(`/v1/ingestion-runs/${id}/reconciliation`)).document).toMatchObject({
    state: "sealed",
    generation: 1,
  });
});

test("a single Card's Erratum budget includes externally retained text", async () => {
  const { post, testEnv, waitForRunState } = await import("./reconciliation-helpers");
  const { collectFixtureEvidence } = await import("../../../test/support/fixture-evidence-plan");
  const started = await post("/v1/ingestion-runs/evidence", {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-erratum-target@1",
    idempotency_key: "erratum-target-text-budget",
    requests: [
      {
        id: "one-piece-en:errata",
        method: "GET",
        url: "https://official-source.invalid/reconciliation/erratum-target-large-text",
        headers: { accept: "application/json" },
      },
    ],
  });
  expect(started.response.status).toBe(201);
  const id = requiredString(started.document, "id");
  await collectFixtureEvidence(testEnv.CATALOGUE_DB, testEnv.EVIDENCE_OBJECTS, testEnv.OFFICIAL_SOURCE_TRANSPORT, id);
  await waitForRunState(id, "parsing");
  const result = await reconcile(id);
  expect(result.response.status).toBe(409);
  expect(result.document).toMatchObject({
    state: "failed",
    diagnostics: expect.arrayContaining([expect.objectContaining({ code: "reconciliation_capacity_exceeded" })]),
  });
  expect((await get(`/v1/ingestion-runs/${id}/reconciliation`)).document).toMatchObject({
    state: "failed",
    failure_code: "reconciliation_capacity_exceeded",
  });
});

test("a published catalogue larger than 1 MiB is streamed into the next candidate without an aggregate prior-payload read", async () => {
  const { approve, testEnv } = await import("./reconciliation-helpers");
  const { runReconciliationWorkflow } = await import("../src/reconciliation-workflow");
  const firstRun = await collect("/reconciliation/prior-candidate-stream", "prior-stream-first");
  const first = await reconcile(firstRun.id);
  expect(first.response.status).toBe(200);
  expect(
    new TextEncoder().encode(JSON.stringify(first.document.cards) + JSON.stringify(first.document.printings))
      .byteLength,
  ).toBeGreaterThan(1024 * 1024);
  const published = await approve(first.document);
  expect(published.response.status, JSON.stringify(published.document)).toBe(200);
  const nextRun = await collect("/reconciliation/prior-candidate-stream", "prior-stream-next");
  const statements = new WeakMap<object, { sql: string; values: unknown[] }>();
  let priorReads = 0;
  const check = (sql: string, values: unknown[]) => {
    if (sql.includes("FROM reconciliation_payload_chunks") && values.includes(firstRun.id)) {
      expect(sql).toContain("LIMIT 1");
      priorReads += 1;
    }
  };
  const wrap = (statement: D1PreparedStatement, sql: string, values: unknown[] = []): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") return (...bound: unknown[]) => wrap(target.bind(...bound), sql, bound);
        const value = Reflect.get(target, property);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          check(sql, values);
          return value.apply(target, args);
        };
      },
    });
    statements.set(proxy, { sql, values });
    return proxy;
  };
  const database = new Proxy(testEnv.CATALOGUE_DB, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (property === "batch")
        return (batch: D1PreparedStatement[]) => {
          for (const statement of batch) {
            const retained = statements.get(statement);
            if (retained) check(retained.sql, retained.values);
          }
          return target.batch(batch);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const event = {
    payload: {
      ingestion_run_id: nextRun.id,
      expected_current_revision_id: requiredString(nextRun.document, "expected_current_revision_id"),
      idempotency_key: "prior-stream-next",
      observed_at: new Date().toISOString(),
      generation: 0,
    },
  } as import("cloudflare:workers").WorkflowEvent<
    import("../../../src/catalogue/reconciliation").ReconciliationWorkflowParams
  >;
  const step = {
    do: async (_name: string, _config: unknown, callback: () => Promise<string>) => callback(),
  } as unknown as import("cloudflare:workers").WorkflowStep;
  await runReconciliationWorkflow({ ...testEnv, CATALOGUE_DB: database }, event, step);
  expect(priorReads).toBeGreaterThan(2);
  expect((await get(`/v1/ingestion-runs/${nextRun.id}/reconciliation`)).document.state).toBe("sealed");
  const status = await get(`/v1/ingestion-runs/${nextRun.id}/reconciliation`);
  const candidateId = (status.document.candidates as { id: string }[])[0]!.id;
  const page = await get(`/v1/game-candidates/${candidateId}/partitions`);
  const cards: unknown[] = [];
  for (const partition of page.document.partitions as { kind: string; ordinal: number }[]) {
    if (partition.kind !== "cards") continue;
    const detail = await get(`/v1/game-candidates/${candidateId}/partitions/${partition.ordinal}`);
    cards.push(...(detail.document.records as unknown[]));
  }
  expect(cards).toEqual(first.document.cards);
});

test("a Product-group storage outage pauses and resumes typed relationships without losing observed Products", async () => {
  const { testEnv, post } = await import("./reconciliation-helpers");
  const { runReconciliationWorkflow } = await import("../src/reconciliation-workflow");
  const run = await collect("/reconciliation/product-typed-relationships", "product-group-outage");
  const statements = new WeakMap<object, { sql: string; values: unknown[] }>();
  let unavailable = true;
  let failures = 0;
  const wrap = (statement: D1PreparedStatement, sql: string, values: unknown[] = []): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") return (...bound: unknown[]) => wrap(target.bind(...bound), sql, bound);
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    statements.set(proxy, { sql, values });
    return proxy;
  };
  const database = new Proxy(testEnv.CATALOGUE_DB, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (property === "batch")
        return (batch: D1PreparedStatement[]) => {
          if (
            unavailable &&
            batch.some((statement) => {
              const entry = statements.get(statement);
              return (
                entry?.sql.includes("INSERT INTO reconciliation_reducer_state") &&
                entry.values.includes("product_observations_one-piece")
              );
            })
          ) {
            failures++;
            throw new Error("Injected Product-group storage outage");
          }
          return target.batch(batch);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const payload = {
    ingestion_run_id: run.id,
    expected_current_revision_id: requiredString(run.document, "expected_current_revision_id"),
    idempotency_key: "product-group-outage",
    observed_at: new Date().toISOString(),
    generation: 0,
  };
  const event = { payload } as import("cloudflare:workers").WorkflowEvent<
    import("../../../src/catalogue/reconciliation").ReconciliationWorkflowParams
  >;
  const step = {
    do: async (_name: string, _config: unknown, callback: () => Promise<string>) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await callback();
        } catch (error) {
          if (attempt === 3) throw error;
        }
      }
    },
  } as unknown as import("cloudflare:workers").WorkflowStep;
  await runReconciliationWorkflow({ ...testEnv, CATALOGUE_DB: database }, event, step);
  expect(failures).toBe(4);
  expect((await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document).toMatchObject({
    state: "paused",
    generation: 1,
  });
  expect(
    (
      await post(`/v1/ingestion-runs/${run.id}/reconciliation/resume`, {
        generation: 1,
        idempotency_key: "resume-product-group",
      })
    ).response.status,
  ).toBe(200);
  unavailable = false;
  await runReconciliationWorkflow(
    { ...testEnv, CATALOGUE_DB: database },
    { payload: { ...payload, generation: 1 } } as typeof event,
    step,
  );
  const status = await get(`/v1/ingestion-runs/${run.id}/reconciliation`);
  expect(status.document.state).toBe("sealed");
  const candidateId = (status.document.candidates as { id: string }[])[0]!.id;
  const page = await get(`/v1/game-candidates/${candidateId}/partitions`);
  const products: Record<string, unknown>[] = [];
  const relationships: Record<string, unknown>[] = [];
  for (const partition of page.document.partitions as { kind: string; ordinal: number }[]) {
    if (!["products", "product_relationships"].includes(partition.kind)) continue;
    const detail = await get(`/v1/game-candidates/${candidateId}/partitions/${partition.ordinal}`);
    (partition.kind === "products" ? products : relationships).push(
      ...(detail.document.records as Record<string, unknown>[]),
    );
  }
  expect(products).toHaveLength(2);
  expect(products.every(({ observed }) => observed === true)).toBe(true);
  expect(relationships.map(({ kind }) => kind)).toEqual(
    expect.arrayContaining(["printing-product", "product-card", "distribution-context-product"]),
  );
});

test("one Product evidence group's capacity budget includes partitioned source text", async () => {
  const run = await collect("/reconciliation/product-group-large-text", "product-group-large-text");
  const result = await reconcile(run.id);
  expect(result.response.status).toBe(409);
  expect((await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document).toMatchObject({
    state: "failed",
    failure_code: "reconciliation_capacity_exceeded",
  });
});

test("curated entity edits resume over the official source view and retain one applied provenance entry", async () => {
  const { approve, post, testEnv, requiredFirst } = await import("./reconciliation-helpers");
  const { canonicalJson, sha256Text } = await import("../../../src/catalogue/shared");
  const { runReconciliationWorkflow } = await import("../src/reconciliation-workflow");
  const seed = await reconcile((await collect("/reconciliation/base", "curated-draft-seed")).id);
  const original = requiredFirst(seed.document, "cards");
  const publishedSeed = await approve(seed.document);
  expect(publishedSeed.response.status).toBe(200);
  const proposal = {
    game: "one-piece",
    target: { kind: "field", entity_type: "card", entity_id: original.id, path: "/name" },
    assertion: { kind: "field", value: "Synthetic curated name" },
    rationale: "Synthetic reviewed source correction",
    evidence: [{ kind: "owner_reference", uri: "https://owner.example/review/draft", content_digest: "a".repeat(64) }],
    effective_interval: { from: null, to: null },
    reviewed_source_digest: await sha256Text(canonicalJson(original.name)),
    supersedes_revision_id: null,
  };
  const created = await post("/admin/v1/curated-revisions", {
    environment: "production",
    expected_current_revision_id: publishedSeed.document.resulting_revision_id,
    proposal,
    proposal_digest: await sha256Text(canonicalJson(proposal)),
    idempotency_key: "curated-draft-create",
  });
  expect(created.response.status, JSON.stringify(created.document)).toBe(201);
  const run = await collect("/reconciliation/base", "curated-draft-next");
  const statements = new WeakMap<object, { sql: string; values: unknown[] }>();
  let unavailable = true;
  let failures = 0;
  const wrap = (statement: D1PreparedStatement, sql: string, values: unknown[] = []): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") return (...bound: unknown[]) => wrap(target.bind(...bound), sql, bound);
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    statements.set(proxy, { sql, values });
    return proxy;
  };
  const database = new Proxy(testEnv.CATALOGUE_DB, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (property === "batch")
        return (batch: D1PreparedStatement[]) => {
          if (
            unavailable &&
            batch.some((statement) => {
              const entry = statements.get(statement);
              return (
                entry?.sql.includes("INSERT INTO reconciliation_reducer_state") &&
                entry.values.includes("candidate_curated_cards")
              );
            })
          ) {
            failures++;
            throw new Error("Injected curated entity storage outage");
          }
          return target.batch(batch);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const payload = {
    ingestion_run_id: run.id,
    expected_current_revision_id: requiredString(run.document, "expected_current_revision_id"),
    idempotency_key: "curated-draft-next",
    observed_at: new Date().toISOString(),
    generation: 0,
  };
  const event = { payload } as import("cloudflare:workers").WorkflowEvent<
    import("../../../src/catalogue/reconciliation").ReconciliationWorkflowParams
  >;
  const step = {
    do: async (_name: string, _config: unknown, callback: () => Promise<string>) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await callback();
        } catch (error) {
          if (attempt === 3) throw error;
        }
      }
    },
  } as unknown as import("cloudflare:workers").WorkflowStep;
  await runReconciliationWorkflow({ ...testEnv, CATALOGUE_DB: database }, event, step);
  expect(failures).toBe(4);
  expect((await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document).toMatchObject({
    state: "paused",
    generation: 1,
  });
  expect(
    (
      await post(`/v1/ingestion-runs/${run.id}/reconciliation/resume`, {
        generation: 1,
        idempotency_key: "resume-curated-draft",
      })
    ).response.status,
  ).toBe(200);
  unavailable = false;
  await runReconciliationWorkflow(
    { ...testEnv, CATALOGUE_DB: database },
    { payload: { ...payload, generation: 1 } } as typeof event,
    step,
  );
  const status = await get(`/v1/ingestion-runs/${run.id}/reconciliation`);
  expect(status.document.state).toBe("sealed");
  const accepted = await post(`/v1/ingestion-runs/${run.id}/approval`, {
    candidate_digest: status.document.candidate_digest,
    expected_current_revision_id: payload.expected_current_revision_id,
    idempotency_key: "publish-curated-draft",
  });
  expect(accepted.response.status, JSON.stringify(accepted.document)).toBe(200);
  const refreshed = await reconcile((await collect("/reconciliation/base", "curated-draft-refresh")).id);
  expect(refreshed.response.status, JSON.stringify(refreshed.document)).toBe(200);
  expect(requiredFirst(refreshed.document, "cards")).toMatchObject({
    id: original.id,
    name: "Synthetic curated name",
    curated_provenance: [expect.objectContaining({ reviewed_source_value: original.name })],
  });
});

test("persistent curated comparison records every changed source field before failing the candidate", async () => {
  const { approve, post, requiredFirst } = await import("./reconciliation-helpers");
  const { canonicalJson, sha256Text } = await import("../../../src/catalogue/shared");
  const seed = await reconcile((await collect("/reconciliation/base", "curated-conflicts-seed")).id);
  const card = requiredFirst(seed.document, "cards");
  const published = await approve(seed.document);
  expect(published.response.status).toBe(200);
  const revisions: string[] = [];
  for (const field of ["name", "effective_rules_text"]) {
    const proposal = {
      game: "one-piece",
      target: { kind: "field", entity_type: "card", entity_id: card.id, path: `/${field}` },
      assertion: { kind: "field", value: `Synthetic curated ${field}` },
      rationale: "Synthetic reviewed correction",
      evidence: [
        { kind: "owner_reference", uri: `https://owner.example/review/${field}`, content_digest: "a".repeat(64) },
      ],
      effective_interval: { from: null, to: null },
      reviewed_source_digest: await sha256Text(canonicalJson(card[field])),
      supersedes_revision_id: null,
    };
    const created = await post("/admin/v1/curated-revisions", {
      environment: "production",
      expected_current_revision_id: published.document.resulting_revision_id,
      proposal,
      proposal_digest: await sha256Text(canonicalJson(proposal)),
      idempotency_key: `curated-conflicts-${field}`,
    });
    expect(created.response.status, JSON.stringify(created.document)).toBe(201);
    revisions.push(requiredString(created.document, "curated_revision_id"));
  }
  const run = await collect("/reconciliation/curated-draft-source-changed", "curated-conflicts-next");
  const { testEnv } = await import("./reconciliation-helpers");
  const { runReconciliationWorkflow } = await import("../src/reconciliation-workflow");
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
  let interruptions = 0;
  const database = new Proxy(testEnv.CATALOGUE_DB, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (property === "batch")
        return (statements: D1PreparedStatement[]) => {
          if (
            interruptions === 0 &&
            statements.some((statement) =>
              sqlByStatement.get(statement)?.includes("reconciliation_preparation_incomplete"),
            )
          ) {
            interruptions++;
            throw new Error("Injected interruption after source-conflict preparation");
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const event = {
    payload: {
      ingestion_run_id: run.id,
      expected_current_revision_id: requiredString(run.document, "expected_current_revision_id"),
      idempotency_key: "curated-conflicts-next",
      observed_at: new Date().toISOString(),
      generation: 0,
    },
  } as import("cloudflare:workers").WorkflowEvent<
    import("../../../src/catalogue/reconciliation").ReconciliationWorkflowParams
  >;
  const step = {
    do: async (_name: string, _config: unknown, callback: () => Promise<string>) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await callback();
        } catch (error) {
          if (attempt === 3) throw error;
        }
      }
    },
  } as unknown as import("cloudflare:workers").WorkflowStep;
  await runReconciliationWorkflow({ ...testEnv, CATALOGUE_DB: database }, event, step);
  expect(interruptions).toBe(1);
  expect((await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document).toMatchObject({ state: "failed" });
  const shownRun = await get(`/v1/ingestion-runs/${run.id}`);
  expect(shownRun.document).toMatchObject({
    state: "failed",
    failure_code: "curated_revision_reconfirmation_required",
  });
  const page = await get(`/v1/ingestion-runs/${run.id}/reconciliation/partitions`);
  const warningPartition = (page.document.partitions as { kind: string; ordinal: number }[]).find(
    ({ kind }) => kind === "warnings",
  )!;
  const detail = await get(`/v1/ingestion-runs/${run.id}/reconciliation/partitions/${warningPartition.ordinal}`);
  expect(detail.document.records).toEqual([
    expect.objectContaining({ code: "curated_revision_reconfirmation_required" }),
    expect.objectContaining({ code: "curated_revision_reconfirmation_required" }),
  ]);
  for (const revision of revisions) {
    const shown = await get(`/admin/v1/curated-revisions/${revision}`);
    expect(shown.document).toMatchObject({
      revision: { status: "reconfirmation_required", pending_conflict: { run_id: run.id } },
    });
  }
});

test("persistent curated edits retain Release ownership and official relationship evidence through refresh", async () => {
  const { approve, post, exportComponentRecords, requiredFirst } = await import("./reconciliation-helpers");
  const { canonicalJson, sha256Text } = await import("../../../src/catalogue/shared");
  const seed = await reconcile((await collect("/reconciliation/product-release", "curated-links-seed")).id);
  const product = requiredFirst(seed.document, "products");
  const release = (product.releases as Record<string, unknown>[])[0]!;
  const published = await approve(seed.document);
  expect(published.response.status).toBe(200);
  const relationship = (
    await exportComponentRecords(String(published.document.resulting_revision_id), "relationships")
  ).find(({ kind }) => kind === "printing-product")!;
  expect(relationship).toBeDefined();
  for (const [index, change] of [
    {
      target: { kind: "field", entity_type: "release", entity_id: release.id, path: "/status" },
      assertion: { kind: "field", value: "released" },
      source: release.status,
    },
    {
      target: {
        kind: "relationship",
        relationship_kind: "printing-product",
        from: relationship.from,
        to: relationship.to,
      },
      assertion: { kind: "relationship", presence: "absent" },
      source: "present",
    },
  ].entries()) {
    const proposal = {
      game: "one-piece",
      target: change.target,
      assertion: change.assertion,
      rationale: "Synthetic reviewed release and membership",
      evidence: [
        { kind: "owner_reference", uri: `https://owner.example/review/link-${index}`, content_digest: "c".repeat(64) },
      ],
      effective_interval: { from: null, to: null },
      reviewed_source_digest: await sha256Text(canonicalJson(change.source)),
      supersedes_revision_id: null,
    };
    const created = await post("/admin/v1/curated-revisions", {
      environment: "production",
      expected_current_revision_id: published.document.resulting_revision_id,
      proposal,
      proposal_digest: await sha256Text(canonicalJson(proposal)),
      idempotency_key: `curated-links-${index}`,
    });
    expect(created.response.status, JSON.stringify(created.document)).toBe(201);
  }
  for (const index of [0, 1]) {
    const run = await collect("/reconciliation/product-release", `curated-links-next-${index}`);
    const candidate = await reconcile(run.id);
    expect(candidate.response.status, JSON.stringify(candidate.document)).toBe(200);
    const status = await get(`/v1/ingestion-runs/${run.id}/reconciliation`);
    const candidateId = (status.document.candidates as { id: string }[])[0]!.id;
    const page = await get(`/v1/game-candidates/${candidateId}/partitions`);
    const records: Record<string, Record<string, unknown>[]> = {};
    for (const partition of page.document.partitions as { kind: string; ordinal: number }[]) {
      if (!["products", "product_relationships"].includes(partition.kind)) continue;
      const detail = await get(`/v1/game-candidates/${candidateId}/partitions/${partition.ordinal}`);
      records[partition.kind] = [
        ...(records[partition.kind] ?? []),
        ...(detail.document.records as Record<string, unknown>[]),
      ];
    }
    expect(records.products).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: product.id,
          releases: [
            expect.objectContaining({
              id: release.id,
              product_id: product.id,
              status: "released",
              curated_provenance: [expect.objectContaining({ reviewed_source_value: "announced" })],
            }),
          ],
        }),
      ]),
    );
    expect(records.product_relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: relationship.id,
          observed: false,
          evidence_category: "explicit",
          source_lineage: "one-piece-en",
          curated_provenance: [expect.objectContaining({ reviewed_source_value: "present" })],
        }),
      ]),
    );
    expect((await approve(candidate.document)).response.status).toBe(200);
  }
});

const retainedStateNamespaces = [
  "current_errata",
  "prior_errata",
  "source_mappings",
  "observation_plans",
  "semantic_memberships",
  "warning_records_sorted",
  "observed_card_ids",
  "prior_observation_counts",
  "initial_evidence_metadata",
];
test.each(retainedStateNamespaces)(
  "a %s storage outage resumes retained identities and effective rules text",
  async (namespace) => {
    const { testEnv, post, approve } = await import("./reconciliation-helpers");
    const { runReconciliationWorkflow } = await import("../src/reconciliation-workflow");
    const seed = await reconcile(
      (await collect("/reconciliation/errata-card-rules-text", `errata-state-seed-${namespace}`)).id,
    );
    expect((await approve(seed.document)).response.status).toBe(200);
    const run = await collect("/reconciliation/errata-card-rules-text", `errata-state-next-${namespace}`);
    const statements = new WeakMap<object, { sql: string; values: unknown[] }>();
    let unavailable = true;
    let failures = 0;
    const wrap = (statement: D1PreparedStatement, sql: string, values: unknown[] = []): D1PreparedStatement => {
      const proxy = new Proxy(statement, {
        get(target, property) {
          if (property === "bind") return (...bound: unknown[]) => wrap(target.bind(...bound), sql, bound);
          if (
            (property === "first" || property === "all") &&
            ((namespace === "prior_observation_counts" && sql.includes("FROM catalogue_revisions AS prior_revision")) ||
              (namespace === "initial_evidence_metadata" &&
                sql.includes("FROM source_requests") &&
                sql.includes("ORDER BY sequence_number, request_id")))
          )
            return () => {
              if (unavailable) {
                failures++;
                throw new Error("Injected prior observation count storage outage");
              }
              return property === "first" ? target.first() : target.all();
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      statements.set(proxy, { sql, values });
      return proxy;
    };
    const database = new Proxy(testEnv.CATALOGUE_DB, {
      get(target, property) {
        if (property === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
        if (property === "batch")
          return (batch: D1PreparedStatement[]) => {
            if (
              unavailable &&
              batch.some((statement) => {
                const entry = statements.get(statement);
                return (
                  (entry?.sql.includes("INSERT INTO reconciliation_reducer_state") ||
                    entry?.sql.includes("INSERT INTO reconciliation_sort_batches")) &&
                  entry.values.includes(namespace)
                );
              })
            ) {
              failures++;
              throw new Error("Injected retained Erratum storage outage");
            }
            return target.batch(batch);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const payload = {
      ingestion_run_id: run.id,
      expected_current_revision_id: requiredString(run.document, "expected_current_revision_id"),
      idempotency_key: "errata-state-outage",
      observed_at: new Date().toISOString(),
      generation: 0,
    };
    const event = { payload } as import("cloudflare:workers").WorkflowEvent<
      import("../../../src/catalogue/reconciliation").ReconciliationWorkflowParams
    >;
    const step = {
      do: async (_name: string, _config: unknown, callback: () => Promise<string>) => {
        for (let attempt = 0; ; attempt++) {
          try {
            return await callback();
          } catch (error) {
            if (attempt === 3) throw error;
          }
        }
      },
    } as unknown as import("cloudflare:workers").WorkflowStep;
    await runReconciliationWorkflow({ ...testEnv, CATALOGUE_DB: database }, event, step);
    expect(failures).toBe(4);
    expect((await get(`/v1/ingestion-runs/${run.id}/reconciliation`)).document).toMatchObject({
      state: "paused",
      generation: 1,
    });
    expect(
      (
        await post(`/v1/ingestion-runs/${run.id}/reconciliation/resume`, {
          generation: 1,
          idempotency_key: "resume-errata-state",
        })
      ).response.status,
    ).toBe(200);
    unavailable = false;
    await runReconciliationWorkflow(
      { ...testEnv, CATALOGUE_DB: database },
      { payload: { ...payload, generation: 1 } } as typeof event,
      step,
    );
    const status = await get(`/v1/ingestion-runs/${run.id}/reconciliation`);
    expect(status.document.state).toBe("sealed");
    const candidateId = (status.document.candidates as { id: string }[])[0]!.id;
    const page = await get(`/v1/game-candidates/${candidateId}/partitions`);
    const records: Record<string, Record<string, unknown>[]> = { cards: [], printings: [], errata: [] };
    for (const partition of page.document.partitions as { kind: string; ordinal: number }[]) {
      if (!(partition.kind in records)) continue;
      const detail = await get(`/v1/game-candidates/${candidateId}/partitions/${partition.ordinal}`);
      records[partition.kind]!.push(...(detail.document.records as Record<string, unknown>[]));
    }
    expect(records.cards).toEqual(seed.document.cards);
    expect(records.printings).toEqual(seed.document.printings);
    expect(records.errata!.map(({ id }) => id)).toEqual((seed.document.errata as { id: string }[]).map(({ id }) => id));
    expect(records.cards![0]).toMatchObject({ effective_rules_text: "[On Play] Draw 2 cards, then discard 1 card." });
  },
);
