import worker from "../src/index";
import { expect, test } from "vitest";
import { collect, get, post, installReconciliationSuite, requiredString, testEnv } from "./reconciliation-helpers";

installReconciliationSuite();

async function sealedCandidate(fixture = "base") {
  const source = await collect(`/reconciliation/${fixture}`, "publication-preparation-source");
  const created = await post("/v1/game-candidates", {
    ingestion_run_id: source.id,
    supported_game: "one-piece",
    expected_game_revision_id: "catrev_spine_000",
    idempotency_key: "publication-preparation-candidate",
  });
  const id = requiredString(created.document, "id");
  let candidate = created.document;
  const deadline = Date.now() + 15000;
  while (candidate.state === "preparing" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    candidate = (await get(`/v1/game-candidates/${id}`)).document;
  }
  expect(candidate).toMatchObject({ state: "sealed" });
  return candidate;
}

test("an owner prepares immutable game artifacts in bounded steps and replays a lost response", async () => {
  const candidate = await sealedCandidate();
  const path = `/v1/game-candidates/${candidate.id}/publication-preparation`;
  const intent = {
    manifest_digest: candidate.manifest_digest,
    generation: 0,
    sequence: 0,
    idempotency_key: "prepare-first",
  };
  const first = await post(path, intent);
  expect(first.response.status, JSON.stringify(first.document)).toBe(200);
  expect(first.document).toMatchObject({
    candidate_id: candidate.id,
    state: "preparing",
    sequence: 1,
    deadline: candidate.deadline,
  });
  expect((await post(path, intent)).document).toEqual(first.document);
  let status = first.document;
  const stages = new Set<string>();
  for (let work = 0; status.state === "preparing" && work < 200; work++) {
    stages.add(String(status.phase));
    const step = await post(path, { ...intent, sequence: status.sequence, idempotency_key: `prepare-${work}` });
    expect(step.response.status, JSON.stringify(step.document)).toBe(200);
    status = step.document;
  }
  expect(status, JSON.stringify(status)).toMatchObject({
    state: "verified",
    root_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    deadline: candidate.deadline,
  });
  expect(stages).toEqual(new Set(["images", "exports", "projections", "composition"]));
  expect((await get(path)).document).toEqual(status);
  expect((await get(`/v1/game-candidates/${candidate.id}`)).document).toEqual(candidate);
});

test("one owner start drives durable publication preparation to verification independently of the request", async () => {
  const candidate = await sealedCandidate();
  const path = `/v1/game-candidates/${candidate.id}/publication-preparation`;
  const intent = {
    manifest_digest: candidate.manifest_digest,
    generation: 0,
    sequence: 0,
    idempotency_key: "automatic-start",
  };
  const start = await post(`${path}/start`, intent);
  expect(start.response.status, JSON.stringify(start.document)).toBe(202);
  let status = (await get(path)).document;
  const until = Date.now() + 15000;
  while (status.state === "preparing" && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    status = (await get(path)).document;
  }
  expect(status, JSON.stringify(status)).toMatchObject({ state: "verified", deadline: candidate.deadline });
  expect((await post(`${path}/start`, intent)).response.status).toBe(202);
});

async function advanceWith(env: Env, path: string, input: Record<string, unknown>) {
  const response = await worker.fetch(
    new Request(`https://card-keepr.invalid${path}`, {
      method: "POST",
      headers: { authorization: "Bearer vitest-administration-key", "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
    env,
  );
  return { response, document: await response.json<Record<string, unknown>>() };
}
async function finish(path: string, intent: Record<string, unknown>, status: Record<string, unknown>) {
  for (let unit = 0; status.state === "preparing" && unit < 1000; unit++) {
    const step = await post(path, {
      ...intent,
      sequence: status.sequence,
      idempotency_key: `finish-${status.sequence}`,
    });
    expect(step.response.status, JSON.stringify(step.document)).toBe(200);
    status = step.document;
  }
  expect(status, JSON.stringify(status)).toMatchObject({ state: "verified" });
  return status;
}

test("partial object staging exhausts bounded retry and resumes without replacing verified work", async () => {
  const candidate = await sealedCandidate();
  const path = `/v1/game-candidates/${candidate.id}/publication-preparation`;
  const intent = {
    manifest_digest: candidate.manifest_digest,
    generation: 0,
    sequence: 0,
    idempotency_key: "partial-start",
  };
  let status = (await post(path, intent)).document;
  while (status.phase !== "exports")
    status = (await post(path, { ...intent, sequence: status.sequence, idempotency_key: `images-${status.sequence}` }))
      .document;
  const before = status.artifact_count;
  const puts = new Map<string, number>();
  const bucket = new Proxy(testEnv.CATALOGUE_EXPORTS, {
    get(target, property) {
      if (property === "put")
        return async (...args: Parameters<R2Bucket["put"]>) => {
          puts.set(args[0], (puts.get(args[0]) ?? 0) + 1);
          await target.put(...args);
          throw new Error("Injected lost object PUT response");
        };
      if (property === "get")
        return async () => {
          throw new Error("Injected object verification outage");
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  for (let attempt = 0; status.state === "preparing" && attempt < 20; attempt++) {
    const result = await advanceWith({ ...testEnv, CATALOGUE_EXPORTS: bucket }, path, {
      ...intent,
      sequence: status.sequence,
      idempotency_key: `fault-${status.sequence}`,
    });
    expect(result.response.status).toBe(200);
    status = result.document;
  }
  expect(status).toMatchObject({
    state: "retry_paused",
    failure_code: "publication_retry_exhausted",
    failures: 3,
    artifact_count: before,
  });
  expect(puts.size).toBeGreaterThan(0);
  expect([...puts.values()]).toEqual([...puts.keys()].map(() => 1));
  const retainedBytes = new Map<string, ArrayBuffer>();
  for (const key of puts.keys())
    retainedBytes.set(key, await (await testEnv.CATALOGUE_EXPORTS.get(key))!.arrayBuffer());
  const paused = status;
  status = (await post(path, { ...intent, sequence: status.sequence, resume: true, idempotency_key: "resume-partial" }))
    .document;
  expect(status).toMatchObject({ state: "preparing", deadline: paused.deadline, artifact_count: before });
  await finish(path, intent, status);
  const artifacts = (await get(`${path}/artifacts`)).document.artifacts as { object_key: string; reused: number }[];
  for (const [key, bytes] of retainedBytes) {
    expect(artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ object_key: key, reused: 1 })]));
    expect(await (await testEnv.CATALOGUE_EXPORTS.get(key))!.arrayBuffer()).toEqual(bytes);
  }
});

test("corrupt immutable image bytes fail distinctly and cannot be resumed", async () => {
  const candidate = await sealedCandidate();
  const path = `/v1/game-candidates/${candidate.id}/publication-preparation`;
  const intent = {
    manifest_digest: candidate.manifest_digest,
    generation: 0,
    sequence: 0,
    idempotency_key: "corrupt-start",
  };
  let status = (await post(path, intent)).document;
  const bucket = new Proxy(testEnv.PRINTING_IMAGES, {
    get(target, property) {
      if (property === "get")
        return async (...args: Parameters<R2Bucket["get"]>) => {
          const object = await target.get(...args);
          if (!object || !("body" in object)) return object;
          await object.body.cancel();
          return {
            ...object,
            body: new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(object.size));
                controller.close();
              },
            }),
          };
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  for (let unit = 0; status.state === "preparing" && unit < 20; unit++)
    status = (
      await advanceWith({ ...testEnv, PRINTING_IMAGES: bucket }, path, {
        ...intent,
        sequence: status.sequence,
        idempotency_key: `corrupt-${status.sequence}`,
      })
    ).document;
  expect(status).toMatchObject({ state: "failed", failure_code: "publication_artifact_corrupt" });
  expect(
    (await post(path, { ...intent, sequence: status.sequence, resume: true, idempotency_key: "cannot-resume-corrupt" }))
      .response.status,
  ).toBe(409);
});

test("a stale sequence, changed manifest, abandoned owner and original deadline fence artifact preparation", async () => {
  const candidate = await sealedCandidate();
  const path = `/v1/game-candidates/${candidate.id}/publication-preparation`;
  const intent = {
    manifest_digest: candidate.manifest_digest,
    generation: 0,
    sequence: 0,
    idempotency_key: "fence-start",
  };
  const status = (await post(path, intent)).document;
  expect((await post(path, { ...intent, idempotency_key: "stale-sequence" })).document).toMatchObject({
    code: "publication_sequence_conflict",
  });
  expect(
    (
      await post(path, {
        ...intent,
        sequence: status.sequence,
        manifest_digest: "a".repeat(64),
        idempotency_key: "wrong-manifest",
      })
    ).document,
  ).toMatchObject({ code: "publication_ownership_conflict" });
  expect(
    (
      await post(
        path,
        { ...intent, sequence: status.sequence, idempotency_key: "expired" },
        { "x-keepr-test-now": new Date(Date.parse(String(candidate.deadline)) + 1).toISOString() },
      )
    ).document,
  ).toMatchObject({ code: "publication_deadline_expired" });
  await post(`/v1/game-candidates/${candidate.id}/abandon`, { generation: 0, idempotency_key: "abandon-preparation" });
  expect(
    (await post(path, { ...intent, sequence: status.sequence, idempotency_key: "abandoned" })).document,
  ).toMatchObject({ code: "publication_ownership_conflict" });
  expect((await get(path)).document).toEqual(status);
});

test("large text is promoted as verified bounded components and hierarchical references", async () => {
  const candidate = await sealedCandidate("large-card-content");
  const path = `/v1/game-candidates/${candidate.id}/publication-preparation`;
  const intent = {
    manifest_digest: candidate.manifest_digest,
    generation: 0,
    sequence: 0,
    idempotency_key: "large-start",
  };
  const status = await finish(path, intent, (await post(path, intent)).document);
  expect((status.progress as { level: number }).level).toBeGreaterThan(0);
  let after: string | null = null;
  const artifacts: Record<string, unknown>[] = [];
  do {
    const page = (await get(`${path}/artifacts${after === null ? "" : `?after=${after}`}`)).document;
    artifacts.push(...(page.artifacts as Record<string, unknown>[]));
    after = page.next_cursor as string | null;
  } while (after !== null);
  expect(artifacts.filter((artifact) => artifact.kind === "text").length).toBeGreaterThan(32);
  expect(artifacts.every((artifact) => Number(artifact.byte_length) <= 524288)).toBe(true);
});

test("a bounded composition references independently verified games without re-uploading their components", async () => {
  const candidate = await sealedCandidate();
  const path = `/v1/game-candidates/${candidate.id}/publication-preparation`;
  const intent = {
    manifest_digest: candidate.manifest_digest,
    generation: 0,
    sequence: 0,
    idempotency_key: "compose-first",
  };
  const first = await finish(path, intent, (await post(path, intent)).document);
  const source = await collect("/reconciliation/profile-fusion-world", "compose-other-source", {
    game: "fusion-world",
    lineage: "fusion-world-en",
    adapter: "fixture-fusion-world-json@2",
  });
  let other = (
    await post("/v1/game-candidates", {
      ingestion_run_id: source.id,
      supported_game: "fusion-world",
      expected_game_revision_id: "catrev_spine_000",
      idempotency_key: "compose-other",
    })
  ).document;
  const until = Date.now() + 15000;
  while (other.state === "preparing" && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    other = (await get(`/v1/game-candidates/${other.id}`)).document;
  }
  expect(other).toMatchObject({ state: "sealed" });
  const otherPath = `/v1/game-candidates/${other.id}/publication-preparation`;
  const otherIntent = {
    manifest_digest: other.manifest_digest,
    generation: 0,
    sequence: 0,
    idempotency_key: "compose-second",
  };
  const started = (await post(otherPath, otherIntent)).document;
  expect(
    (await post("/v1/publication-compositions", { candidate_ids: [candidate.id, other.id] })).response.status,
  ).toBe(409);
  // Request keys are globally scoped; use a distinct prefix for this independent game.
  let second = started;
  for (let unit = 0; second.state === "preparing" && unit < 200; unit++)
    second = (
      await post(otherPath, { ...otherIntent, sequence: second.sequence, idempotency_key: `other-${second.sequence}` })
    ).document;
  expect(second, JSON.stringify(second)).toMatchObject({ state: "verified" });
  const composed = await post("/v1/publication-compositions", { candidate_ids: [candidate.id, other.id] });
  expect(composed.response.status, JSON.stringify(composed.document)).toBe(200);
  expect(composed.document.games).toEqual([
    { supported_game: "fusion-world", candidate_id: other.id, root_digest: second.root_digest },
    { supported_game: "one-piece", candidate_id: candidate.id, root_digest: first.root_digest },
  ]);
  expect((await post("/v1/publication-compositions", { candidate_ids: [other.id, candidate.id] })).document).toEqual(
    composed.document,
  );
  expect((await get(path)).document).toEqual(first);
  expect((await get(otherPath)).document).toEqual(second);
});

test("verified query and search batches expose the same prepared facts to the owner", async () => {
  const candidate = await sealedCandidate();
  const path = `/v1/game-candidates/${candidate.id}/publication-preparation`;
  const intent = {
    manifest_digest: candidate.manifest_digest,
    generation: 0,
    sequence: 0,
    idempotency_key: "query-start",
  };
  await finish(path, intent, (await post(path, intent)).document);
  const result = await get(`${path}/query?kind=cards&q=luffy`);
  expect(result.response.status, JSON.stringify(result.document)).toBe(200);
  expect(result.document.records).toEqual([
    expect.objectContaining({ value: expect.objectContaining({ name: "Monkey.D.Luffy" }) }),
  ]);
  expect((await get(`${path}/query?kind=cards&q=absent-needle`)).document.records).toEqual([]);
});

test("an empty complete game seals a verified empty composition", async () => {
  const candidate = await sealedCandidate("complete-empty-lineage");
  const path = `/v1/game-candidates/${candidate.id}/publication-preparation`;
  const intent = {
    manifest_digest: candidate.manifest_digest,
    generation: 0,
    sequence: 0,
    idempotency_key: "empty-start",
  };
  const status = await finish(path, intent, (await post(path, intent)).document);
  expect(status).toMatchObject({ state: "verified", artifact_count: 4 });
  const artifacts = (await get(`${path}/artifacts`)).document.artifacts as { kind: string }[];
  expect(artifacts.map(({ kind }) => kind).sort()).toEqual([
    "game_profiles",
    "query_search",
    "query_search",
    "supported_games",
  ]);
  expect((await get(`${path}/query?kind=cards`)).document.records).toEqual([]);
  expect((await get(`${path}/query?kind=printings`)).document.records).toEqual([]);
});

test.each(["projections", "composition"])(
  "%s recovers partial staging and a lost transaction response",
  async (phase) => {
    const candidate = await sealedCandidate();
    const path = `/v1/game-candidates/${candidate.id}/publication-preparation`;
    const intent = {
      manifest_digest: candidate.manifest_digest,
      generation: 0,
      sequence: 0,
      idempotency_key: `${phase}-start`,
    };
    let status = (await post(path, intent)).document;
    const entityPartition = (
      (await get(`/v1/game-candidates/${candidate.id}/partitions`)).document.partitions as {
        kind: string;
        ordinal: number;
      }[]
    ).find((part) => part.kind === "cards")!.ordinal;
    while (
      status.phase !== phase ||
      (phase === "projections" && Number((status.progress as { partition: number }).partition) < entityPartition)
    )
      status = (await post(path, { ...intent, sequence: status.sequence, idempotency_key: `seek-${status.sequence}` }))
        .document;
    const retained = status.artifact_count,
      progress = status.progress;
    const unavailable = new Proxy(testEnv.CATALOGUE_EXPORTS, {
      get(target, property) {
        if (property === "get")
          return async () => {
            throw new Error("Injected verification outage after partial staging");
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    for (let count = 0; status.state === "preparing" && count < 4; count++)
      status = (
        await advanceWith({ ...testEnv, CATALOGUE_EXPORTS: unavailable }, path, {
          ...intent,
          sequence: status.sequence,
          idempotency_key: `outage-${status.sequence}`,
        })
      ).document;
    expect(status).toMatchObject({
      state: "retry_paused",
      failure_code: "publication_retry_exhausted",
      artifact_count: retained,
      progress,
    });
    status = (
      await post(path, { ...intent, sequence: status.sequence, resume: true, idempotency_key: "resume-staging" })
    ).document;
    let lost = false;
    const db = new Proxy(testEnv.CATALOGUE_DB, {
      get(target, property) {
        if (property === "batch")
          return async (statements: D1PreparedStatement[]) => {
            const result = await target.batch(statements);
            const committed = await target
              .prepare("SELECT 1 FROM publication_preparation_actions WHERE idempotency_key='lost-commit'")
              .first();
            if (!lost && committed) {
              lost = true;
              throw new Error("Injected lost D1 commit response");
            }
            return result;
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const request = { ...intent, sequence: status.sequence, idempotency_key: "lost-commit" };
    const result = await advanceWith({ ...testEnv, CATALOGUE_DB: db }, path, request);
    expect(result.response.status, JSON.stringify(result.document)).toBe(200);
    expect((await post(path, request)).document).toEqual(result.document);
    expect(lost).toBe(true);
    await finish(path, intent, result.document);
  },
);

test.each(["prepare publication artifacts", "dispatch publication preparation successor"])(
  "exhausted %s steps retain a retry pause",
  async (failedStep) => {
    // Keep the successor fault beyond one shard after bounded artifact batching.
    const candidate = await sealedCandidate(
      failedStep === "dispatch publication preparation successor" ? "three-role-image-work-units" : "base",
    );
    const path = `/v1/game-candidates/${candidate.id}/publication-preparation`;
    let parameters: import("../../../src/catalogue/reconciliation").ReconciliationWorkflowParams | undefined;
    const workflow = {
      create: async (options: {
        params: import("../../../src/catalogue/reconciliation").ReconciliationWorkflowParams;
      }) => {
        parameters = options.params;
        return { status: async () => ({ status: "queued" }) };
      },
    } as unknown as Env["RECONCILIATION_WORKFLOW"];
    const intent = {
      manifest_digest: candidate.manifest_digest,
      generation: 0,
      sequence: 0,
      idempotency_key: "workflow-failure-start",
    };
    const started = await advanceWith({ ...testEnv, RECONCILIATION_WORKFLOW: workflow }, `${path}/start`, intent);
    expect(started.response.status).toBe(202);
    const { runReconciliationWorkflow } = await import("../src/reconciliation-workflow");
    let injected = false;
    await runReconciliationWorkflow(
      testEnv,
      {
        payload: parameters!,
        instanceId: "injected-publication-step-exhaustion",
        timestamp: new Date(),
      } as import("cloudflare:workers").WorkflowEvent<
        import("../../../src/catalogue/reconciliation").ReconciliationWorkflowParams
      >,
      {
        do: async (name: string, _config: unknown, callback: () => Promise<string>) => {
          if (name.startsWith(failedStep)) {
            injected = true;
            throw new Error("Injected Workflow step has exhausted its transport retries");
          }
          return callback();
        },
      } as unknown as import("cloudflare:workers").WorkflowStep,
    );
    const status = (await get(path)).document;
    expect(injected).toBe(true);
    expect(status).toMatchObject({
      state: "retry_paused",
      failure_code: "publication_workflow_retry_exhausted",
      deadline: candidate.deadline,
    });
    const resumed = await post(`${path}/resume`, {
      ...intent,
      sequence: status.sequence,
      idempotency_key: "resume-exhausted-workflow",
    });
    expect(resumed.response.status, JSON.stringify(resumed.document)).toBe(202);
    let complete = (await get(path)).document;
    const deadline = Date.now() + 15000;
    while (complete.state === "preparing" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      complete = (await get(path)).document;
    }
    expect(complete, JSON.stringify(complete)).toMatchObject({ state: "verified", deadline: candidate.deadline });
  },
);

test("initial Workflow dispatch exhaustion is retained and resumes from the same candidate", async () => {
  const candidate = await sealedCandidate();
  const path = `/v1/game-candidates/${candidate.id}/publication-preparation`;
  let attempts = 0;
  const workflow = {
    create: async () => {
      attempts++;
      throw new Error("Injected dispatch transport outage");
    },
    get: async () => {
      throw new Error("Injected dispatch lookup outage");
    },
  } as unknown as Env["RECONCILIATION_WORKFLOW"];
  const intent = {
    manifest_digest: candidate.manifest_digest,
    generation: 0,
    sequence: 0,
    idempotency_key: "dispatch-unavailable",
  };
  const result = await advanceWith({ ...testEnv, RECONCILIATION_WORKFLOW: workflow }, `${path}/start`, intent);
  expect(result.response.status, JSON.stringify(result.document)).toBe(202);
  expect(attempts).toBe(3);
  const status = (await get(path)).document;
  expect(status).toMatchObject({
    state: "retry_paused",
    failure_code: "publication_dispatch_retry_exhausted",
    deadline: candidate.deadline,
  });
  const resumed = await post(`${path}/resume`, {
    ...intent,
    sequence: status.sequence,
    idempotency_key: "dispatch-recovered",
  });
  expect(resumed.response.status).toBe(202);
  let complete = (await get(path)).document;
  const deadline = Date.now() + 15000;
  while (complete.state === "preparing" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    complete = (await get(path)).document;
  }
  expect(complete, JSON.stringify(complete)).toMatchObject({ state: "verified", deadline: candidate.deadline });
});

test.each(["projections", "composition"])("%s rejects corrupted staged bytes without replacing them", async (phase) => {
  const candidate = await sealedCandidate();
  const path = `/v1/game-candidates/${candidate.id}/publication-preparation`;
  const intent = {
    manifest_digest: candidate.manifest_digest,
    generation: 0,
    sequence: 0,
    idempotency_key: "staged-corruption",
  };
  let status = (await post(path, intent)).document;
  const entityPartition = (
    (await get(`/v1/game-candidates/${candidate.id}/partitions`)).document.partitions as {
      kind: string;
      ordinal: number;
    }[]
  ).find((part) => part.kind === "cards")!.ordinal;
  while (
    status.phase !== phase ||
    (phase === "projections" && Number((status.progress as { partition: number }).partition) < entityPartition)
  )
    status = (await post(path, { ...intent, sequence: status.sequence, idempotency_key: `seek-${status.sequence}` }))
      .document;
  const bucket = new Proxy(testEnv.CATALOGUE_EXPORTS, {
    get(target, property) {
      if (property === "get")
        return async (...args: Parameters<R2Bucket["get"]>) => {
          const object = await target.get(...args);
          if (!object || !("body" in object)) return object;
          await object.body.cancel();
          return {
            ...object,
            body: new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(object.size));
                controller.close();
              },
            }),
          };
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const result = await advanceWith({ ...testEnv, CATALOGUE_EXPORTS: bucket }, path, {
    ...intent,
    sequence: status.sequence,
    idempotency_key: "corrupt-staged-object",
  });
  expect(result.document).toMatchObject({
    state: "failed",
    failure_code: "publication_artifact_corrupt",
    artifact_count: status.artifact_count,
    progress: status.progress,
  });
});

test("a fresh candidate reuses unchanged fact components while retaining a distinct bound root", async () => {
  const candidate = await sealedCandidate();
  const path = `/v1/game-candidates/${candidate.id}/publication-preparation`;
  const intent = {
    manifest_digest: candidate.manifest_digest,
    generation: 0,
    sequence: 0,
    idempotency_key: "reuse-first",
  };
  const first = await finish(path, intent, (await post(path, intent)).document);
  const original = (await get(`${path}/artifacts`)).document.artifacts as { kind: string; object_key: string }[];
  await post(`/v1/game-candidates/${candidate.id}/abandon`, {
    generation: 0,
    idempotency_key: "replace-prepared-candidate",
  });
  let next = (
    await post("/v1/game-candidates", {
      ingestion_run_id: candidate.ingestion_run_id,
      supported_game: "one-piece",
      expected_game_revision_id: "catrev_spine_000",
      idempotency_key: "fresh-unchanged-candidate",
    })
  ).document;
  const deadline = Date.now() + 15000;
  while (next.state === "preparing" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    next = (await get(`/v1/game-candidates/${next.id}`)).document;
  }
  expect(next).toMatchObject({ state: "sealed" });
  const nextPath = `/v1/game-candidates/${next.id}/publication-preparation`;
  const nextIntent = {
    manifest_digest: next.manifest_digest,
    generation: 0,
    sequence: 0,
    idempotency_key: "reuse-second",
  };
  let status = (await post(nextPath, nextIntent)).document;
  for (let unit = 0; status.state === "preparing" && unit < 200; unit++)
    status = (
      await post(nextPath, { ...nextIntent, sequence: status.sequence, idempotency_key: `reuse-${status.sequence}` })
    ).document;
  expect(status, JSON.stringify(status)).toMatchObject({ state: "verified" });
  expect(status.root_digest).not.toBe(first.root_digest);
  const reused = (await get(`${nextPath}/artifacts`)).document.artifacts as {
    kind: string;
    object_key: string;
    reused: number;
  }[];
  const originalCard = original.find((artifact) => artifact.kind === "cards")!;
  expect(reused).toContainEqual(
    expect.objectContaining({ kind: "cards", object_key: originalCard.object_key, reused: 1 }),
  );
});

test("an exhausted stale Workflow cannot pause a newer owner's sequence", async () => {
  const candidate = await sealedCandidate();
  const path = `/v1/game-candidates/${candidate.id}/publication-preparation`;
  let parameters: import("../../../src/catalogue/reconciliation").ReconciliationWorkflowParams | undefined;
  const workflow = {
    create: async (options: {
      params: import("../../../src/catalogue/reconciliation").ReconciliationWorkflowParams;
    }) => {
      parameters = options.params;
      return { status: async () => ({ status: "queued" }) };
    },
  } as unknown as Env["RECONCILIATION_WORKFLOW"];
  const intent = {
    manifest_digest: candidate.manifest_digest,
    generation: 0,
    sequence: 0,
    idempotency_key: "stale-workflow-start",
  };
  await advanceWith({ ...testEnv, RECONCILIATION_WORKFLOW: workflow }, `${path}/start`, intent);
  let newer: Record<string, unknown> | undefined;
  const { runReconciliationWorkflow } = await import("../src/reconciliation-workflow");
  await runReconciliationWorkflow(
    testEnv,
    {
      payload: parameters!,
      instanceId: "stale-failure",
      timestamp: new Date(),
    } as import("cloudflare:workers").WorkflowEvent<
      import("../../../src/catalogue/reconciliation").ReconciliationWorkflowParams
    >,
    {
      do: async (name: string, _config: unknown, callback: () => Promise<string>) => {
        if (name.startsWith("prepare publication artifacts")) {
          newer = (await post(path, { ...intent, sequence: 1, idempotency_key: "newer-owner-work" })).document;
          throw new Error("Injected stale Workflow exhausts retries after the newer owner advances");
        }
        return callback();
      },
    } as unknown as import("cloudflare:workers").WorkflowStep,
  );
  expect(newer).toMatchObject({ state: "preparing", sequence: 2 });
  expect((await get(path)).document).toEqual(newer);
  await finish(path, intent, newer!);
});

test("a lost old start replay cannot pause newer work when its original dispatch fails", async () => {
  const candidate = await sealedCandidate();
  const path = `/v1/game-candidates/${candidate.id}/publication-preparation`;
  const queued = {
    create: async () => ({ status: async () => ({ status: "queued" }) }),
  } as unknown as Env["RECONCILIATION_WORKFLOW"];
  const intent = {
    manifest_digest: candidate.manifest_digest,
    generation: 0,
    sequence: 0,
    idempotency_key: "old-start-replay",
  };
  await advanceWith({ ...testEnv, RECONCILIATION_WORKFLOW: queued }, `${path}/start`, intent);
  const newer = (await post(path, { ...intent, sequence: 1, idempotency_key: "newer-start-work" })).document;
  const unavailable = {
    create: async () => {
      throw new Error("Injected old dispatch outage");
    },
    get: async () => {
      throw new Error("Injected old dispatch lookup outage");
    },
  } as unknown as Env["RECONCILIATION_WORKFLOW"];
  await advanceWith({ ...testEnv, RECONCILIATION_WORKFLOW: unavailable }, `${path}/start`, intent);
  expect((await get(path)).document).toEqual(newer);
  await finish(path, intent, newer);
});

test.each(["inspection", "inspection_summary"])(
  "publication preparation verifies retained %s metadata as part of the whole manifest",
  async (kind) => {
    const candidate = await sealedCandidate();
    const statement = (original: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(original, {
        get(target, property) {
          if (property === "bind") return (...values: unknown[]) => statement(target.bind(...values));
          if (property === "first")
            return async (...args: unknown[]) => {
              const value = await Reflect.apply(target.first, target, args);
              return value && typeof value === "object" && "kind" in value && value.kind === kind
                ? { ...value, sha256: "0".repeat(64) }
                : value;
            };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    const database = new Proxy(testEnv.CATALOGUE_DB, {
      get(target, property) {
        if (property === "prepare") return (sql: string) => statement(target.prepare(sql));
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const path = `/v1/game-candidates/${candidate.id}/publication-preparation`;
    const intent = { manifest_digest: candidate.manifest_digest, generation: 0 };
    let status = { state: "preparing", sequence: 0 } as Record<string, unknown>;
    for (let unit = 0; status.state === "preparing" && unit < 200; unit++) {
      const result = await advanceWith({ ...testEnv, CATALOGUE_DB: database }, path, {
        ...intent,
        sequence: status.sequence,
        idempotency_key: `verify-inspection-${unit}`,
      });
      expect(result.response.status, JSON.stringify(result.document)).toBe(200);
      status = result.document;
    }
    expect(status).toMatchObject({ state: "failed", failure_code: "publication_partition_corrupt" });
    expect((await get(`/v1/game-candidates/${candidate.id}/inspection`)).document).toMatchObject({ ready: true });
  },
);
