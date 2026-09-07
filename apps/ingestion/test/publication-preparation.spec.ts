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
  let puts = 0;
  const bucket = new Proxy(testEnv.CATALOGUE_EXPORTS, {
    get(target, property) {
      if (property === "put")
        return async (...args: Parameters<R2Bucket["put"]>) => {
          puts++;
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
  expect(puts).toBe(1);
  const paused = status;
  status = (await post(path, { ...intent, sequence: status.sequence, resume: true, idempotency_key: "resume-partial" }))
    .document;
  expect(status).toMatchObject({ state: "preparing", deadline: paused.deadline, artifact_count: before });
  await finish(path, intent, status);
  const artifacts = (await get(`${path}/artifacts`)).document.artifacts as { kind: string; reused: number }[];
  expect(artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "cards", reused: 1 })]));
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
