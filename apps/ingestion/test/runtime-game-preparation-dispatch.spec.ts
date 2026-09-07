import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { injectFixtureEvidencePlan } from "./fixture-plan-injection";
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
  }
  await parent.restart();
  await waitForWorkflowStatus(accepted.workflow.id, () => parent.status(), "complete", 20000);
  expect((await parent.status()).output).toEqual(output);
}, 45000);
