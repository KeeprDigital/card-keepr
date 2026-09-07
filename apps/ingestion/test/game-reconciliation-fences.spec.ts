import { expect, test } from "vitest";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { ReconciliationWorkflowParams } from "../../../src/catalogue/reconciliation";
import worker from "../src/index";
import {
  approve,
  collect,
  get,
  installReconciliationSuite,
  reconcile,
  requiredString,
  post,
  testEnv,
} from "./reconciliation-helpers";
import { replaceGameHeadForFence } from "./query-helpers/game-candidates";
import {
  setOperationStateRecoveryHealth,
  setOperationStateRecoveryHealthForRecoveryHealthGatesFixtureEvidenceInjectionReconciliationBeforeMutation,
} from "./query-helpers/ingestion";
import { runReconciliationWorkflow } from "./reconciliation-workflow-driver";

installReconciliationSuite();

test.each(["resume", "seal"])("a changed game predecessor fences native %s", async (boundary) => {
  const seed = await reconcile((await collect("/reconciliation/base", `native-${boundary}-seed`)).id);
  const published = await approve(seed.document);
  expect(published.response.status).toBe(200);
  const predecessor = requiredString(published.document, "resulting_revision_id");
  const run = await collect("/reconciliation/base", `native-${boundary}-evidence`);
  let params: ReconciliationWorkflowParams | undefined;
  const instance = { status: async () => ({ status: "queued" }) } as unknown as WorkflowInstance;
  const workflow = {
    create: async (options: { params: ReconciliationWorkflowParams }) => {
      params = options.params;
      return instance;
    },
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
  const created = await request("/v1/game-candidates", {
    ingestion_run_id: run.id,
    supported_game: "one-piece",
    expected_game_revision_id: predecessor,
    idempotency_key: `native-${boundary}-intent`,
  });
  expect(created.status).toBe(201);
  const id = requiredString(created.document, "id");
  const changeHead = () => replaceGameHeadForFence(testEnv.CATALOGUE_DB).bind("catrev_spine_000", "one-piece").run();
  if (boundary === "resume") {
    expect(
      (await request(`/v1/game-candidates/${id}/pause`, { generation: 0, idempotency_key: "pause-before-head-change" }))
        .status,
    ).toBe(200);
    await changeHead();
    const resumed = await request(`/v1/game-candidates/${id}/resume`, {
      generation: 1,
      idempotency_key: "resume-after-head-change",
    });
    expect(resumed.status, JSON.stringify(resumed.document)).toBe(409);
    expect(resumed.document).toMatchObject({ code: "game_revision_mismatch" });
    expect((await get(`/v1/game-candidates/${id}`)).document).toMatchObject({
      state: "paused",
      generation: 1,
      deadline: created.document.deadline,
    });
    return;
  }
  let interrupted = false;
  const sqlByStatement = new WeakMap<object, string>();
  const wrap = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, key) {
        if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql);
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    sqlByStatement.set(proxy, sql);
    return proxy;
  };
  const database = new Proxy(testEnv.CATALOGUE_DB, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) => {
          if (
            !interrupted &&
            statements.some((statement) =>
              sqlByStatement.get(statement)?.includes("UPDATE game_candidates SET state = ?"),
            )
          ) {
            interrupted = true;
            await changeHead();
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, key);
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
  } as unknown as WorkflowStep;
  await runReconciliationWorkflow(
    { ...testEnv, CATALOGUE_DB: database },
    { instanceId: `native-fence-${boundary}`, payload: params! } as WorkflowEvent<ReconciliationWorkflowParams>,
    step,
  );
  expect(interrupted).toBe(true);
  expect((await get(`/v1/game-candidates/${id}`)).document).toMatchObject({
    state: "failed",
    failure_code: "game_revision_mismatch",
    expected_game_revision_id: predecessor,
    deadline: created.document.deadline,
  });
  expect((await get(`/v1/ingestion-runs/${run.id}`)).document).toMatchObject({ state: "parsing" });
});

test("an authority change between policy read and creation cannot produce mixed native pins", async () => {
  const run = await collect("/reconciliation/base", "native-policy-race-source");
  const published = await approve((await reconcile(run.id)).document);
  expect(published.response.status).toBe(200);
  const intent = {
    ingestion_run_id: run.id,
    supported_game: "one-piece",
    expected_game_revision_id: published.document.resulting_revision_id,
    idempotency_key: "native-policy-race-intent",
  };
  const instance = { status: async () => ({ status: "queued" }) } as unknown as WorkflowInstance;
  const workflow = {
    create: async () => instance,
    get: async () => instance,
  } as unknown as Env["RECONCILIATION_WORKFLOW"];
  let raced = false;
  const database = new Proxy(testEnv.CATALOGUE_DB, {
    get(target, key) {
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) => {
          if (!raced) {
            raced = true;
            const changed = await worker.fetch(
              new Request("https://card-keepr.invalid/v1/source-authorities", {
                method: "POST",
                headers: { authorization: "Bearer vitest-administration-key", "content-type": "application/json" },
                body: JSON.stringify({
                  game: "one-piece",
                  locale: "en",
                  release_region: "OCEANIA",
                  area: "card_facts",
                  source_lineage: "limitless-one-piece-en",
                  expected_generation: "0",
                  rationale: "Synthetic policy race",
                  idempotency_key: "native-policy-race-decision",
                }),
              }),
              testEnv,
            );
            expect(changed.status, await changed.text()).toBe(200);
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const request = async (db: D1Database) => {
    const response = await worker.fetch(
      new Request("https://card-keepr.invalid/v1/game-candidates", {
        method: "POST",
        headers: { authorization: "Bearer vitest-administration-key", "content-type": "application/json" },
        body: JSON.stringify(intent),
      }),
      { ...testEnv, CATALOGUE_DB: db, RECONCILIATION_WORKFLOW: workflow },
    );
    return { status: response.status, document: await response.json<Record<string, unknown>>() };
  };
  const conflicted = await request(database);
  expect(raced).toBe(true);
  expect(conflicted.status, JSON.stringify(conflicted.document)).toBe(409);
  expect(conflicted.document).toMatchObject({ code: "reconciliation_policy_changed" });
  const retried = await request(testEnv.CATALOGUE_DB);
  expect(retried.status, JSON.stringify(retried.document)).toBe(201);
  expect(retried.document).toMatchObject({ state: "preparing", generation: 0 });
});

test("concurrent exact native intents create one operation and replay its original identity", async () => {
  const run = await collect("/reconciliation/base", "native-exact-concurrency-source");
  const intent = {
    ingestion_run_id: run.id,
    supported_game: "one-piece",
    expected_game_revision_id: "catrev_spine_000",
    idempotency_key: "native-exact-concurrent-intent",
  };
  const instance = { status: async () => ({ status: "queued" }) } as unknown as WorkflowInstance;
  const workflow = {
    create: async () => instance,
    get: async () => instance,
  } as unknown as Env["RECONCILIATION_WORKFLOW"];
  const request = async (database: D1Database = testEnv.CATALOGUE_DB) => {
    const response = await worker.fetch(
      new Request("https://card-keepr.invalid/v1/game-candidates", {
        method: "POST",
        headers: { authorization: "Bearer vitest-administration-key", "content-type": "application/json" },
        body: JSON.stringify(intent),
      }),
      { ...testEnv, CATALOGUE_DB: database, RECONCILIATION_WORKFLOW: workflow },
    );
    return { status: response.status, document: await response.json<Record<string, unknown>>() };
  };
  let winner: Awaited<ReturnType<typeof request>> | undefined;
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, key) {
        if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
        if (key === "first")
          return async (...args: unknown[]) => {
            const snapshot = await Reflect.apply(target.first, target, args);
            if (!winner) winner = await request();
            return snapshot;
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const database = new Proxy(testEnv.CATALOGUE_DB, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) =>
          sql.includes("FROM game_reconciliation_requests WHERE idempotency_key")
            ? wrap(target.prepare(sql))
            : target.prepare(sql);
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const delayed = await request(database);
  const results = [winner!, delayed];
  expect(results.map((result) => result.status).sort()).toEqual([200, 201]);
  expect(results[0]!.document).toEqual(results[1]!.document);
  expect((await request()).document).toEqual(results[0]!.document);
});

test("a native preparation excludes a supplemental proposal whose owner link arrived after its decision pin", async () => {
  const initial = await reconcile(
    (await collect("/reconciliation/canonical-official", "native-admission-pin-seed")).id,
  );
  const cardId = (initial.document.cards as { id: string }[])[0]!.id;
  expect((await approve(initial.document)).response.status).toBe(200);
  for (const area of ["card_facts", "printing_details"]) {
    const response = await worker.fetch(
      new Request("https://card-keepr.invalid/v1/source-authorities", {
        method: "POST",
        headers: { authorization: "Bearer vitest-administration-key", "content-type": "application/json" },
        body: JSON.stringify({
          game: "one-piece",
          locale: "en",
          release_region: "OCEANIA",
          area,
          source_lineage: "limitless-one-piece-en",
          expected_generation: "0",
          rationale: "Synthetic pinned admission",
          idempotency_key: `native-pinned-${area}`,
        }),
      }),
      testEnv,
    );
    expect(response.status, await response.text()).toBe(200);
  }
  const source = await collect("/reconciliation/canonical-tabular-unresolved", "native-admission-pin-source", {
    game: "one-piece",
    lineage: "limitless-one-piece-en",
    adapter: "fixture-one-piece-tabular@1",
  });
  const unresolved = await reconcile(source.id);
  const published = await approve(unresolved.document);
  expect(published.response.status, JSON.stringify(published.document)).toBe(200);
  const proposal = ((await get("/v1/entity-proposals?game=one-piece")).document.proposals as { id: string }[])[0]!;
  let params: ReconciliationWorkflowParams | undefined;
  const instance = { status: async () => ({ status: "queued" }) } as unknown as WorkflowInstance;
  const workflow = {
    create: async (options: { params: ReconciliationWorkflowParams }) => {
      params = options.params;
      return instance;
    },
    get: async () => instance,
  } as unknown as Env["RECONCILIATION_WORKFLOW"];
  const response = await worker.fetch(
    new Request("https://card-keepr.invalid/v1/game-candidates", {
      method: "POST",
      headers: { authorization: "Bearer vitest-administration-key", "content-type": "application/json" },
      body: JSON.stringify({
        ingestion_run_id: source.id,
        supported_game: "one-piece",
        expected_game_revision_id: published.document.resulting_revision_id,
        idempotency_key: "native-pinned-late-link",
      }),
    }),
    { ...testEnv, RECONCILIATION_WORKFLOW: workflow },
  );
  expect(response.status).toBe(201);
  const id = requiredString(await response.json<Record<string, unknown>>(), "id");
  const linked = await worker.fetch(
    new Request(`https://card-keepr.invalid/v1/entity-proposals/${proposal.id}/decisions`, {
      method: "POST",
      headers: { authorization: "Bearer vitest-administration-key", "content-type": "application/json" },
      body: JSON.stringify({
        action: "link",
        card_id: cardId,
        printing_id: (initial.document.printings as { id: string }[])[0]!.id,
        exception: {
          scope: ["identity"],
          attestation: "Synthetic owner inspection establishes the existing Printing identity.",
        },
        expected_generation: "0",
        rationale: "Synthetic later owner link",
        idempotency_key: "native-owner-link-after-pin",
      }),
    }),
    testEnv,
  );
  expect(linked.status, await linked.text()).toBe(200);
  await runReconciliationWorkflow(
    testEnv,
    { instanceId: "native-pinned-late-link-worker", payload: params! } as WorkflowEvent<ReconciliationWorkflowParams>,
    {
      do: async (_name: string, _config: unknown, callback: () => Promise<string>) => callback(),
    } as unknown as WorkflowStep,
  );
  expect((await get(`/v1/game-candidates/${id}`)).document).toMatchObject({ state: "sealed" });
  const partitions = (await get(`/v1/game-candidates/${id}/partitions`)).document.partitions as {
    ordinal: number;
    kind: string;
  }[];
  const warnings: Record<string, unknown>[] = [];
  for (const partition of partitions.filter((part) => part.kind === "warnings" || part.kind === "shared_warnings"))
    warnings.push(
      ...((await get(`/v1/game-candidates/${id}/partitions/${partition.ordinal}`)).document.records as Record<
        string,
        unknown
      >[]),
    );
  expect(warnings).toContainEqual(expect.objectContaining({ code: "entity_proposal_excluded" }));
  expect((await get(`/v1/entity-proposals/${proposal.id}`)).document).toMatchObject({
    status: "admitted",
    generation: 1,
    history: [expect.objectContaining({ action: "link" })],
  });
});

test.each(["link", "reject"])(
  "a native preparation preserves its snapshot when a new proposal receives a later owner %s",
  async (action) => {
    const seed = await reconcile(
      (
        await collect(
          action === "link" ? "/reconciliation/canonical-official" : "/reconciliation/card-without-printing",
          "native-new-proposal-seed",
        )
      ).id,
    );
    const card = (seed.document.cards as { id: string }[])[0]!;
    const published = await approve(seed.document);
    expect(published.response.status).toBe(200);
    for (const area of ["card_facts", "printing_details"])
      expect(
        (
          await post("/v1/source-authorities", {
            game: "one-piece",
            locale: "en",
            release_region: "OCEANIA",
            area,
            source_lineage: "limitless-one-piece-en",
            expected_generation: "0",
            rationale: "Synthetic retained supplemental source",
            idempotency_key: `new-proposal-${area}`,
          })
        ).response.status,
      ).toBe(200);
    const source = await collect(
      action === "link" ? "/reconciliation/canonical-tabular-unresolved" : "/reconciliation/canonical-tabular",
      "native-new-proposal-source",
      {
        game: "one-piece",
        lineage: "limitless-one-piece-en",
        adapter: "fixture-one-piece-tabular@1",
      },
    );
    let params: ReconciliationWorkflowParams | undefined;
    const queued = { status: async () => ({ status: "queued" }) } as unknown as WorkflowInstance;
    const workflow = {
      create: async (input: { params: ReconciliationWorkflowParams }) => {
        params = input.params;
        return queued;
      },
      get: async () => queued,
    } as unknown as Env["RECONCILIATION_WORKFLOW"];
    const response = await worker.fetch(
      new Request("https://card-keepr.invalid/v1/game-candidates", {
        method: "POST",
        headers: { authorization: "Bearer vitest-administration-key", "content-type": "application/json" },
        body: JSON.stringify({
          ingestion_run_id: source.id,
          supported_game: "one-piece",
          expected_game_revision_id: published.document.resulting_revision_id,
          idempotency_key: "native-new-proposal-pin",
        }),
      }),
      { ...testEnv, RECONCILIATION_WORKFLOW: workflow },
    );
    expect(response.status).toBe(201);
    const id = requiredString(await response.json<Record<string, unknown>>(), "id");
    const evidence = (await get(`/v1/ingestion-runs/${source.id}/evidence`)).document;
    const setId = (evidence.observation_sets as { id: string }[])[0]!.id;
    const observations = (await get(`/v1/source-observation-sets/${setId}/content`)).document.observations as {
      value: { identity_evidence: { locator: string; variant_key?: string | null } };
    }[];
    const identity = observations[0]!.value.identity_evidence;
    const proposal = await post("/v1/entity-proposals", {
      game: "one-piece",
      source_lineage: "limitless-one-piece-en",
      reference: JSON.stringify([identity.locator, identity.variant_key ?? null]),
      content: { card },
      evidence: { attestation: "Synthetic owner inspection of existing card" },
      idempotency_key: "native-proposal-after-pin",
    });
    expect(proposal.response.status, JSON.stringify(proposal.document)).toBe(201);
    const linked = await post(`/v1/entity-proposals/${proposal.document.id}/decisions`, {
      action,
      ...(action === "link" ? { card_id: card.id } : {}),
      expected_generation: "0",
      rationale: "A later owner decision belongs in the next preparation.",
      idempotency_key: "native-new-proposal-link",
    });
    expect(linked.response.status, JSON.stringify(linked.document)).toBe(200);
    await runReconciliationWorkflow(
      testEnv,
      { instanceId: "native-new-proposal-worker", payload: params! } as WorkflowEvent<ReconciliationWorkflowParams>,
      {
        do: async (_name: string, _config: unknown, callback: () => Promise<string>) => callback(),
      } as unknown as WorkflowStep,
    );
    const candidate = (await get(`/v1/game-candidates/${id}`)).document;
    expect(candidate, JSON.stringify(candidate)).toMatchObject({ state: "sealed" });
    const partitions = (await get(`/v1/game-candidates/${id}/partitions`)).document.partitions as {
      ordinal: number;
      kind: string;
    }[];
    const warnings: Record<string, unknown>[] = [];
    for (const part of partitions.filter((p) => p.kind === "warnings" || p.kind === "shared_warnings"))
      warnings.push(
        ...((await get(`/v1/game-candidates/${id}/partitions/${part.ordinal}`)).document.records as Record<
          string,
          unknown
        >[]),
      );
    if (action === "link")
      expect(warnings).toContainEqual(expect.objectContaining({ code: "entity_proposal_excluded" }));
    else expect(warnings).not.toContainEqual(expect.objectContaining({ code: "entity_proposal_excluded" }));
    expect((await get(`/v1/entity-proposals/${proposal.document.id}`)).document).toMatchObject({
      status: action === "link" ? "admitted" : "rejected",
      generation: 1,
    });
  },
);

test.each(["pause", "abandon-paused", "abandon-sealed"])(
  "blocked recovery atomically fences native %s",
  async (boundary) => {
    const source = await collect("/reconciliation/base", `recovery-${boundary}-source`);
    const created = await post("/v1/game-candidates", {
      ingestion_run_id: source.id,
      supported_game: "one-piece",
      expected_game_revision_id: "catrev_spine_000",
      idempotency_key: `recovery-${boundary}-candidate`,
    });
    expect(created.response.status).toBe(201);
    const id = requiredString(created.document, "id");
    if (boundary === "abandon-paused")
      expect(
        (await post(`/v1/game-candidates/${id}/pause`, { generation: 0, idempotency_key: "recovery-initial-pause" }))
          .response.status,
      ).toBe(200);
    if (boundary === "abandon-sealed") {
      const until = Date.now() + 15000;
      while ((await get(`/v1/game-candidates/${id}`)).document.state === "preparing" && Date.now() < until)
        await new Promise((resolve) => setTimeout(resolve, 25));
      expect((await get(`/v1/game-candidates/${id}`)).document.state).toBe("sealed");
    }
    const before = (await get(`/v1/game-candidates/${id}`)).document;
    const action = boundary === "pause" ? "pause" : "abandon";
    const body = { generation: before.generation, idempotency_key: `recovery-${boundary}-action` };
    await setOperationStateRecoveryHealth(testEnv.CATALOGUE_DB).run();
    try {
      const refused = await post(`/v1/game-candidates/${id}/${action}`, body);
      expect(refused.response.status, JSON.stringify(refused.document)).toBe(409);
      expect(refused.document).toMatchObject({ code: "recovery_not_verified" });
      expect((await get(`/v1/game-candidates/${id}`)).document).toMatchObject({
        state: before.state,
        generation: before.generation,
        deadline: before.deadline,
      });
    } finally {
      await setOperationStateRecoveryHealthForRecoveryHealthGatesFixtureEvidenceInjectionReconciliationBeforeMutation(
        testEnv.CATALOGUE_DB,
      ).run();
    }
    expect((await post(`/v1/game-candidates/${id}/${action}`, body)).response.status).toBe(200);
  },
);
