import { expect, test } from "vitest";
import { collectFixtureEvidence } from "../../../test/support/fixture-evidence-plan";
import {
  get,
  collect,
  reconcile,
  approve,
  installReconciliationSuite,
  post,
  postFixtureEvidence,
  requiredString,
  testEnv,
} from "./reconciliation-helpers";

installReconciliationSuite();

test("preparation checks its game predecessor independently of another game's publication", async () => {
  const seed = await collect("/reconciliation/base", "native-predecessor-seed");
  const published = await approve((await reconcile(seed.id)).document);
  expect(published.response.status).toBe(200);
  const revision = requiredString(published.document, "resulting_revision_id");
  const onePiece = await collect("/reconciliation/base", "native-predecessor-next");
  const stale = await post("/v1/game-candidates", {
    ingestion_run_id: onePiece.id,
    supported_game: "one-piece",
    expected_game_revision_id: "catrev_spine_000",
    idempotency_key: "native-stale-predecessor",
  });
  expect(stale.response.status).toBe(409);
  expect(stale.document).toMatchObject({ code: "game_revision_mismatch" });
  const current = await post("/v1/game-candidates", {
    ingestion_run_id: onePiece.id,
    supported_game: "one-piece",
    expected_game_revision_id: revision,
    idempotency_key: "native-current-predecessor",
  });
  expect(current.response.status, JSON.stringify(current.document)).toBe(201);
  const fusion = await collect("/reconciliation/profile-fusion-world", "native-unrelated-predecessor", {
    game: "fusion-world",
    lineage: "fusion-world-en",
    adapter: "fixture-fusion-world-json@2",
  });
  const unrelated = await post("/v1/game-candidates", {
    ingestion_run_id: fusion.id,
    supported_game: "fusion-world",
    expected_game_revision_id: "catrev_spine_000",
    idempotency_key: "native-unrelated-game",
  });
  expect(unrelated.response.status, JSON.stringify(unrelated.document)).toBe(201);
  for (const candidate of [current, unrelated]) {
    const id = requiredString(candidate.document, "id");
    const deadline = Date.now() + 15000;
    let status = (await get(`/v1/game-candidates/${id}`)).document;
    while (status.state === "preparing" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      status = (await get(`/v1/game-candidates/${id}`)).document;
    }
    expect(status, JSON.stringify(status)).toMatchObject({
      state: "sealed",
      expected_game_revision_id: candidate.document.expected_game_revision_id,
    });
  }
});

test.each([
  ["capacity-high-degree-observation", "reconciliation_capacity_exceeded"],
  ["identity-whitespace", "retained_evidence_invalid"],
])("a game preparation reports terminal %s failure without failing its collection", async (fixture, code) => {
  const run = await collect(`/reconciliation/${fixture}`, "native-failure-evidence");
  const intent = {
    ingestion_run_id: run.id,
    supported_game: "one-piece",
    expected_game_revision_id: "catrev_spine_000",
    idempotency_key: "native-capacity-intent",
  };
  const created = await post("/v1/game-candidates", intent);
  expect(created.response.status).toBe(201);
  const id = requiredString(created.document, "id");
  let candidate = (await get(`/v1/game-candidates/${id}`)).document;
  const deadline = Date.now() + 15000;
  while (candidate.state === "preparing" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    candidate = (await get(`/v1/game-candidates/${id}`)).document;
  }
  expect(candidate, JSON.stringify(candidate)).toMatchObject({
    state: "failed",
    failure_code: code,
    outcome: {
      preparation_id: id,
      run_id: run.id,
      state: "failed",
      failure_code: code,
      diagnostics: expect.any(Array),
    },
  });
  expect((await get(`/v1/ingestion-runs/${run.id}`)).document).toMatchObject({ state: "parsing" });
  expect((await post("/v1/game-candidates", intent)).document).toEqual(candidate);
});

test("two games from one collection prepare independently while one operation is paused", async () => {
  const collected = await postFixtureEvidence({
    idempotency_key: "independent-game-collection",
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
  expect(collected.response.status).toBe(201);
  const runId = requiredString(collected.document, "id");
  await collectFixtureEvidence(
    testEnv.CATALOGUE_DB,
    testEnv.EVIDENCE_OBJECTS,
    testEnv.OFFICIAL_SOURCE_TRANSPORT,
    runId,
  );
  const intent = {
    ingestion_run_id: runId,
    supported_game: "one-piece",
    expected_game_revision_id: "catrev_spine_000",
    idempotency_key: "independent-one-piece",
  };
  const first = await post("/v1/game-candidates", intent);
  expect(first.response.status).toBe(201);
  const firstId = requiredString(first.document, "id");
  const paused = await post(`/v1/game-candidates/${firstId}/pause`, {
    generation: 0,
    idempotency_key: "pause-one-piece",
  });
  expect(paused.response.status).toBe(200);
  expect(paused.document).toMatchObject({ state: "paused", generation: 1, deadline: first.document.deadline });

  const second = await post("/v1/game-candidates", {
    ...intent,
    supported_game: "fusion-world",
    idempotency_key: "independent-fusion-world",
  });
  expect(second.response.status).toBe(201);
  const secondId = requiredString(second.document, "id");
  expect(secondId).not.toBe(firstId);
  const deadline = Date.now() + 15000;
  let sealed = (await get(`/v1/game-candidates/${secondId}`)).document;
  while (sealed.state === "preparing" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    sealed = (await get(`/v1/game-candidates/${secondId}`)).document;
  }
  expect(sealed, JSON.stringify(sealed)).toMatchObject({
    state: "sealed",
    generation: 0,
    deadline: second.document.deadline,
  });
  expect((await get(`/v1/game-candidates/${firstId}`)).document).toMatchObject({
    state: "paused",
    generation: 1,
    deadline: first.document.deadline,
  });
  const replay = await post("/v1/game-candidates", intent);
  expect(replay.response.status).toBe(200);
  expect(replay.document).toMatchObject({ id: firstId, state: "paused" });
  const inputs = await get(`/v1/game-candidates/${secondId}/inputs`);
  expect(inputs.response.status).toBe(200);
  expect(inputs.document).toMatchObject({ ingestion_run_id: runId, preparation_id: secondId, verified: true });
  const observations: Record<string, unknown>[] = [];
  for (const partition of inputs.document.partitions as { kind: string; ordinal: number }[]) {
    if (partition.kind !== "observations") continue;
    const detail = await get(`/v1/game-candidates/${secondId}/inputs/${partition.ordinal}`);
    expect(detail.response.status).toBe(200);
    observations.push(...(detail.document.records as Record<string, unknown>[]));
  }
  expect(observations.length).toBeGreaterThan(0);
  expect(observations.map((observation) => observation.sourceLineage)).toEqual(
    observations.map(() => "fusion-world-en"),
  );
  const resumed = await post(`/v1/game-candidates/${firstId}/resume`, {
    generation: 1,
    idempotency_key: "resume-one-piece",
  });
  expect(resumed.response.status).toBe(200);
  expect(resumed.document).toMatchObject({ state: "preparing", generation: 1, deadline: first.document.deadline });
  const resumedDeadline = Date.now() + 15000;
  let completed = (await get(`/v1/game-candidates/${firstId}`)).document;
  while (completed.state === "preparing" && Date.now() < resumedDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    completed = (await get(`/v1/game-candidates/${firstId}`)).document;
  }
  expect(completed, JSON.stringify(completed)).toMatchObject({
    state: "sealed",
    generation: 1,
    deadline: first.document.deadline,
  });
  expect((await get(`/v1/game-candidates/${secondId}`)).document).toMatchObject({ state: "sealed", generation: 0 });
});

test("abandonment releases only its game slot and a new intent creates a fresh candidate from the same collection", async () => {
  const run = await collect("/reconciliation/base", "fresh-game-preparation");
  const intent = {
    ingestion_run_id: run.id,
    supported_game: "one-piece",
    expected_game_revision_id: "catrev_spine_000",
    idempotency_key: "first-game-intent",
  };
  const first = await post("/v1/game-candidates", intent);
  expect(first.response.status).toBe(201);
  const id = requiredString(first.document, "id");
  expect(
    (await post(`/v1/game-candidates/${id}/pause`, { generation: 0, idempotency_key: "pause-before-abandon" })).response
      .status,
  ).toBe(200);
  const occupied = await post("/v1/game-candidates", { ...intent, idempotency_key: "competing-game-intent" });
  expect(occupied.response.status).toBe(409);
  expect(occupied.document).toMatchObject({ code: "game_candidate_slot_occupied" });
  const expired = await post(
    `/v1/game-candidates/${id}/resume`,
    { generation: 1, idempotency_key: "expired-game-resume" },
    { "x-keepr-test-now": new Date(Date.parse(String(first.document.deadline)) + 1).toISOString() },
  );
  expect(expired.response.status).toBe(409);
  expect(expired.document).toMatchObject({ code: "reconciliation_deadline_expired" });
  const changed = await post("/v1/game-candidates", { ...intent, supported_game: "fusion-world" });
  expect(changed.response.status).toBe(409);
  expect(changed.document).toMatchObject({ code: "idempotency_conflict" });
  const abandoned = await post(`/v1/game-candidates/${id}/abandon`, {
    generation: 1,
    idempotency_key: "abandon-game-intent",
  });
  expect(abandoned.response.status).toBe(200);
  expect(abandoned.document).toMatchObject({ state: "abandoned", generation: 2, deadline: first.document.deadline });
  const fresh = await post("/v1/game-candidates", { ...intent, idempotency_key: "competing-game-intent" });
  expect(fresh.response.status, JSON.stringify(fresh.document)).toBe(201);
  expect(fresh.document.id).not.toBe(id);
  expect(fresh.document).toMatchObject({ ingestion_run_id: run.id, generation: 0 });
  expect((await get(`/v1/game-candidates/${id}`)).document).toMatchObject({
    state: "abandoned",
    generation: 2,
    deadline: first.document.deadline,
  });
  const replay = await post("/v1/game-candidates", intent);
  expect(replay.response.status).toBe(200);
  expect(replay.document).toMatchObject({ id, state: "abandoned" });
});
