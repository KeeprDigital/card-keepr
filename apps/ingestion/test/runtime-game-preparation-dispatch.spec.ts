import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { injectFixtureEvidencePlan } from "./fixture-plan-injection";
import { collectFixtureEvidence } from "../../../test/support/fixture-evidence-plan";
import { administrationRequest, installRuntimeSuite, waitForWorkflowStatus } from "./runtime-helpers";

installRuntimeSuite();

test("a collection parent dispatches independent game preparations and replays their retained identities", async () => {
  const collection = await injectFixtureEvidencePlan(env.CATALOGUE_DB, {
    idempotency_key: "native-parent-two-games",
    plans: [
      {
        supported_game: "one-piece",
        source_lineage: "one-piece-en",
        adapter_version: "fixture-one-piece-json@3",
        requests: [{ id: "one-piece-en:cards", url: "https://official-source.invalid/reconciliation/base" }],
      },
      {
        supported_game: "fusion-world",
        source_lineage: "fusion-world-en",
        adapter_version: "fixture-fusion-world-json@2",
        requests: [
          { id: "fusion-world-en:cards", url: "https://official-source.invalid/reconciliation/profile-fusion-world" },
        ],
      },
    ],
  });
  const response = await administrationRequest(`/v1/ingestion-runs/${collection.id}/collection/resume`, "POST");
  expect(response.status).toBe(202);
  const accepted = await response.json<{ workflow: { id: string } }>();
  const parent = await env.EVIDENCE_INGESTION_WORKFLOW.get(accepted.workflow.id);
  await waitForWorkflowStatus(accepted.workflow.id, () => parent.status(), "complete", 20000);
  const output = (await parent.status()).output as {
    ingestion_run_id: string;
    game_preparations: { id: string; supported_game: string }[];
  };
  expect(output).toMatchObject({
    ingestion_run_id: collection.id,
    game_preparations: [
      { supported_game: "fusion-world", id: expect.any(String) },
      { supported_game: "one-piece", id: expect.any(String) },
    ],
  });
  expect(new Set(output.game_preparations.map(({ id }) => id)).size).toBe(2);
  const evidenceResponse = await administrationRequest(`/v1/ingestion-runs/${collection.id}/evidence`, "GET");
  const evidence = await evidenceResponse.json<{ collection_completed_at: string }>();
  const originalDeadlines = new Map<string, { created_at: unknown; deadline: unknown }>();
  for (const candidate of output.game_preparations) {
    let document: Record<string, unknown> = {};
    const deadline = Date.now() + 15000;
    do {
      const inspected = await administrationRequest(`/v1/game-candidates/${candidate.id}`, "GET");
      expect(inspected.status).toBe(200);
      document = await inspected.json<Record<string, unknown>>();
      if (document.state !== "preparing") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    expect(document, JSON.stringify(document)).toMatchObject({
      id: candidate.id,
      ingestion_run_id: collection.id,
      supported_game: candidate.supported_game,
      state: "sealed",
    });
    expect(candidate.id).not.toBe(collection.id);
    expect(Date.parse(String(document.created_at))).toBeGreaterThan(Date.parse(evidence.collection_completed_at));
    expect(Date.parse(String(document.deadline)) - Date.parse(String(document.created_at))).toBe(604800000);
    originalDeadlines.set(candidate.id, { created_at: document.created_at, deadline: document.deadline });
  }
  await parent.restart();
  await waitForWorkflowStatus(accepted.workflow.id, () => parent.status(), "complete", 20000);
  expect((await parent.status()).output).toEqual(output);
  for (const [id, original] of originalDeadlines) {
    const inspected = await administrationRequest(`/v1/game-candidates/${id}`, "GET");
    expect(await inspected.json()).toMatchObject(original);
  }
}, 45000);

test("an occupied game slot does not prevent the collection parent from dispatching another game", async () => {
  const fusion = {
    supported_game: "fusion-world",
    source_lineage: "fusion-world-en",
    adapter_version: "fixture-fusion-world-json@2",
    requests: [{ id: "fusion-cards", url: "https://official-source.invalid/reconciliation/profile-fusion-world" }],
  };
  const prior = await injectFixtureEvidencePlan(env.CATALOGUE_DB, {
    ...fusion,
    idempotency_key: "parent-occupied-fusion-source",
  });
  await collectFixtureEvidence(env.CATALOGUE_DB, env.EVIDENCE_OBJECTS, env.OFFICIAL_SOURCE_TRANSPORT, String(prior.id));
  const occupied = await administrationRequest("/v1/game-candidates", "POST", {
    ingestion_run_id: prior.id,
    supported_game: "fusion-world",
    expected_game_revision_id: "catrev_spine_000",
    idempotency_key: "parent-occupied-fusion-candidate",
  });
  expect(occupied.status).toBe(201);
  const original = await occupied.json<{ id: string }>();
  const collection = await injectFixtureEvidencePlan(env.CATALOGUE_DB, {
    idempotency_key: "parent-occupied-two-games",
    plans: [
      fusion,
      {
        supported_game: "one-piece",
        source_lineage: "one-piece-en",
        adapter_version: "fixture-one-piece-json@3",
        requests: [{ id: "one-piece-cards", url: "https://official-source.invalid/reconciliation/base" }],
      },
    ],
  });
  const response = await administrationRequest(`/v1/ingestion-runs/${collection.id}/collection/resume`, "POST");
  expect(response.status).toBe(202);
  const accepted = await response.json<{ workflow: { id: string } }>();
  const parent = await env.EVIDENCE_INGESTION_WORKFLOW.get(accepted.workflow.id);
  await waitForWorkflowStatus(accepted.workflow.id, () => parent.status(), "complete", 20000);
  const output = (await parent.status()).output as { game_preparations: Record<string, unknown>[] };
  expect(output.game_preparations).toMatchObject([
    { supported_game: "fusion-world", state: "blocked", code: "game_candidate_slot_occupied" },
    { supported_game: "one-piece", id: expect.any(String) },
  ]);
  expect(output.game_preparations[1]!.id).not.toBe(original.id);
  let candidate: Record<string, unknown> = {};
  const deadline = Date.now() + 15000;
  do {
    const inspected = await administrationRequest(`/v1/game-candidates/${output.game_preparations[1]!.id}`, "GET");
    expect(inspected.status).toBe(200);
    candidate = await inspected.json<Record<string, unknown>>();
    if (candidate.state !== "preparing") break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  expect(candidate, JSON.stringify(candidate)).toMatchObject({
    ingestion_run_id: collection.id,
    supported_game: "one-piece",
    state: "sealed",
  });
  const retained = await administrationRequest(`/v1/game-candidates/${original.id}`, "GET");
  expect(await retained.json()).toMatchObject({ ingestion_run_id: prior.id, supported_game: "fusion-world" });
}, 30000);
