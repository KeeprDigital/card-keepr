import { expect, test } from "vitest";
import { catalogueStore } from "../../../src/catalogue/shared";
import { compositionEntityResponse } from "../../../src/catalogue/read/composition-read";
import { compositionExportResponse } from "../../../src/catalogue/read/composition-export";
import { collect, get, post, installReconciliationSuite, testEnv } from "./reconciliation-helpers";
import {
  admitSyntheticCurrentCheckpoint,
  currentGameMembers,
  retainedQueryRevisions,
} from "./query-helpers/atomic-publication";

installReconciliationSuite();

// Bounded synthetic capacity/retention regression. Checkpoint guard admission is
// synthetic; actual SQL restoration is proved separately by native acceptance.
test("five published games preserve sibling roots and current plus two query revisions", {
  timeout: 120_000,
}, async () => {
  for (const area of ["card_facts", "printing_details"]) {
    const designation = await post("/v1/source-authorities", {
      game: "riftbound",
      locale: "en",
      release_region: "US",
      area,
      source_lineage: "riftbound-en",
      expected_generation: "0",
      rationale: "Synthetic five-game composition fixture",
      idempotency_key: `five-authority-${area}`,
    });
    expect(designation.response.status).toBe(200);
  }
  const sources = [
    { game: "one-piece", lineage: "one-piece-en", adapter: "fixture-one-piece-json@3", scenario: "base" },
    {
      game: "fusion-world",
      lineage: "fusion-world-en",
      adapter: "fixture-fusion-world-json@2",
      scenario: "profile-fusion-world",
    },
    { game: "digimon", lineage: "digimon-en", adapter: "fixture-digimon-json@2", scenario: "profile-digimon" },
    { game: "gundam", lineage: "gundam-en-asia", adapter: "fixture-gundam-en-asia-json@2", scenario: "profile-gundam" },
    { game: "riftbound", lineage: "riftbound-en", adapter: "fixture-riftbound-json@1", scenario: "profile-riftbound" },
  ];
  const revisions: string[] = [];
  let riftboundRun = "";
  for (const source of sources) {
    const before = (await currentGameMembers(testEnv.CATALOGUE_DB)).results;
    const run = await collect(`/reconciliation/${source.scenario}`, `five-${source.game}`, source);
    if (source.game === "riftbound") riftboundRun = run.id;
    revisions.push(await publish(run.id, source.game, "catrev_spine_000", source.game));
    const after = (await currentGameMembers(testEnv.CATALOGUE_DB)).results;
    expect(after).toHaveLength(before.length + 1);
    for (const sibling of before) expect(after).toContainEqual(sibling);
  }
  const five = (await currentGameMembers(testEnv.CATALOGUE_DB)).results;
  expect(five.map((m) => m.supported_game).sort()).toEqual(sources.map((s) => s.game).sort());
  const base = { origin: "https://catalogue.example", basePath: "" };
  for (const game of sources.map((s) => s.game)) {
    const response = await compositionEntityResponse(
      catalogueStore(testEnv.CATALOGUE_DB),
      new Request(`${base.origin}/v1/cards?game=${game}`),
      base,
      "cards",
    );
    expect(response?.status).toBe(200);
    const document = (await response!.json()) as { data: { game: string }[] };
    expect(document.data.length).toBeGreaterThan(0);
    expect(document.data.every((card) => card.game === game)).toBe(true);
  }
  for (let repeat = 0; repeat < 3; repeat++) {
    const previous = (await currentGameMembers(testEnv.CATALOGUE_DB)).results;
    const head = previous.find((m) => m.supported_game === "riftbound")!;
    revisions.push(await publish(riftboundRun, "riftbound", head.game_revision_id, `riftbound-${repeat}`));
    const after = (await currentGameMembers(testEnv.CATALOGUE_DB)).results;
    expect(after).toHaveLength(5);
    for (const sibling of previous.filter((m) => m.supported_game !== "riftbound"))
      expect(after).toContainEqual(sibling);
    expect(after.find((m) => m.supported_game === "riftbound")!.card_ids).toBe(head.card_ids);
  }
  const retained = (await retainedQueryRevisions(testEnv.CATALOGUE_DB)).results;
  expect(
    retained
      .filter((r) => r.state !== "archived")
      .map((r) => r.catalogue_revision_id)
      .sort(),
  ).toEqual(revisions.slice(-3).sort());
  for (const revision of revisions.slice(-3)) {
    const response = await compositionExportResponse(
      catalogueStore(testEnv.CATALOGUE_DB),
      new Request(`${base.origin}/v1/catalogue-exports/${revision}`),
      base,
      revision,
      testEnv.CATALOGUE_EXPORTS,
    );
    expect(response?.status).toBe(200);
    const document = (await response!.json()) as { data: { supported_games: string[] } };
    expect(document.data.supported_games.sort()).toEqual(sources.map((s) => s.game).sort());
  }
});

async function publish(run: string, game: string, predecessor: string, key: string): Promise<string> {
  let candidate = (
    await post("/v1/game-candidates", {
      ingestion_run_id: run,
      supported_game: game,
      expected_game_revision_id: predecessor,
      idempotency_key: `five-candidate-${key}`,
    })
  ).document;
  const deadline = Date.now() + 15_000;
  while (candidate.state === "preparing" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    candidate = (await get(`/v1/game-candidates/${candidate.id}`)).document;
  }
  expect(candidate.state, JSON.stringify(candidate)).toBe("sealed");
  let preparation: Record<string, unknown> = { state: "preparing", sequence: 0 };
  for (let unit = 0; preparation.state === "preparing" && unit < 250; unit++) {
    preparation = (
      await post(`/v1/game-candidates/${candidate.id}/publication-preparation`, {
        manifest_digest: candidate.manifest_digest,
        generation: 0,
        sequence: preparation.sequence,
        idempotency_key: `five-artifacts-${key}-${unit}`,
      })
    ).document;
  }
  expect(preparation.state, JSON.stringify(preparation)).toBe("verified");
  const approval = await post("/v1/publications", {
    candidate_id: candidate.id,
    manifest_digest: candidate.manifest_digest,
    expected_game_revision_id: predecessor,
    generation: candidate.generation,
    idempotency_key: `five-approval-${key}`,
  });
  expect(approval.response.status, JSON.stringify(approval.document)).toBe(202);
  let exports: Record<string, unknown> = { state: "preparing" };
  for (let unit = 0; exports.state === "preparing" && unit < 250; unit++)
    exports = (
      await post(`/v1/publications/${approval.document.id}/export-preparation/advance`, {
        generation: 0,
        idempotency_key: `five-exports-${key}-${unit}`,
      })
    ).document;
  expect(exports.state, JSON.stringify(exports)).toBe("verified");
  await admitSyntheticCurrentCheckpoint(testEnv.CATALOGUE_DB);
  const published = await post(`/v1/publications/${approval.document.id}/advance`, { generation: 0 });
  expect(published.document.state, JSON.stringify(published.document)).toBe("published");
  return String(published.document.resulting_revision_id);
}
