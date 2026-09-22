import { fixtureAcquisitionBudget } from "../../../test/support/fixture-evidence-plan";
import { expect, test } from "vitest";
import first from "../../../acceptance/fixtures/real-sources/2026-09-21-hexdeck/raw/search-set-page-1.html?raw";
import seventh from "../../../acceptance/fixtures/real-sources/2026-09-21-hexdeck/raw/search-set-page-7.html?raw";
import { catalogueStore } from "../../../src/catalogue/shared";
import { startEvidenceRun } from "../../../src/catalogue/source-evidence";
import { requiredSourceAdapter } from "../../../src/catalogue/adapters";
import { collectFixtureEvidence } from "../../../test/support/fixture-evidence-plan";
import { installReconciliationSuite, requiredString, testEnv } from "./reconciliation-helpers";
import { prepareNativeEvidence } from "./native-publication-helpers";
import { nativeCandidateRecords } from "./native-candidate-helpers";
import { inspectEntityProposal } from "../../../src/catalogue/reconciliation/entity-admission";
import { reviewProposals } from "./query-helpers/source-admission-evidence";
import { parseHexdeckSearchPage } from "../../../src/catalogue/adapters/hexdeck-gallery";
import { syntheticHexdeckSearchPage } from "../../../test/support/synthetic-flight-pages.mjs";

installReconciliationSuite({ directPreparation: true });

// Two synthetic census pages carry the 100 unchanged listings of retained pages
// 1 and 7; only the pagination envelope is synthetic. Every front is an injected
// outage, so this proves discovery, parent-checked pages and retained review
// records, not image coverage.
test("the HexDeck census follows page 1's implied pages and retains every listing for owner review", async () => {
  const adapter = requiredSourceAdapter("hexdeck-en@1");
  const db = catalogueStore(testEnv.CATALOGUE_DB);
  const census = (page: number) =>
    `https://www.hexdeck.io/cards?displayFormat=Images&page=${page}&sortField=Set&sortDirection=Ascending`;
  const listings = [first, seventh].map((body, index) =>
    parseHexdeckSearchPage(body, adapter.requestUrlForSurface!(index === 0 ? "set-slice" : "token-page")).rows.map(
      (row) => row.record as { imageUrl: string },
    ),
  );
  const pages = new Map(
    listings.map((results, index) => [
      census(index + 1),
      syntheticHexdeckSearchPage({ page: index + 1, pageSize: 50, totalCount: 100, results }),
    ]),
  );
  const started = await startEvidenceRun(db, {
    acquisition_budget: fixtureAcquisitionBudget,
    idempotency_key: "hexdeck-census",
    plans: [
      {
        supported_game: "riftbound",
        source_lineage: "hexdeck-en",
        adapter_version: adapter.adapterVersion,
        subset: "search-census",
        requests: [{ id: "hexdeck-en:search-census", url: census(1) }],
      },
    ],
  });
  const runId = String(started.id);
  const requested: string[] = [];
  await collectFixtureEvidence(
    testEnv.CATALOGUE_DB,
    testEnv.EVIDENCE_OBJECTS,
    {
      async fetch(input: RequestInfo | URL) {
        const url = new Request(input).url;
        requested.push(url);
        const page = pages.get(url);
        if (page) return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
        return new Response("Injected image outage", { status: 404 });
      },
    } as Fetcher,
    runId,
  );
  expect(requested.filter((url) => pages.has(url)).sort()).toEqual([...pages.keys()].sort());
  expect(requested.filter((url) => !pages.has(url))).toHaveLength(100);
  const candidate = await prepareNativeEvidence({
    runId,
    game: "riftbound",
    predecessor: "catrev_spine_000",
    key: "hexdeck-census-candidate",
  });
  const candidateRecords = await nativeCandidateRecords(requiredString(candidate, "id"), ["cards", "printings"]);
  expect(candidateRecords.cards ?? []).toHaveLength(0);
  expect(candidateRecords.printings ?? []).toHaveLength(0);
  const proposals = (await reviewProposals(db).bind("hexdeck-en").all<{ id: string; reference: string }>()).results;
  expect(proposals).toHaveLength(100);
  const inspected = await inspectEntityProposal(db, proposals[0]!.id);
  expect(inspected.status).toBe("unresolved");
  expect(inspected.evidence.issues.map((issue: { code: string }) => issue.code)).toEqual([
    "card_facts_incomplete",
    "printing_treatment_unresolved",
    "physical_issuance_unresolved",
  ]);
});

test.each(["missing", "mismatched"])(
  "HexDeck %s fronts distinguish tolerated absence from contradictory retained bytes",
  async (failure) => {
    const adapter = requiredSourceAdapter("hexdeck-en@1");
    const db = catalogueStore(testEnv.CATALOGUE_DB);
    const bodies = new Map([
      [adapter.requestUrlForSurface!("set-slice"), first],
      [adapter.requestUrlForSurface!("token-page"), seventh],
    ]);
    const started = await startEvidenceRun(db, {
      acquisition_budget: fixtureAcquisitionBudget,
      idempotency_key: `hexdeck-${failure}-images`,
      plans: [
        {
          supported_game: "riftbound",
          source_lineage: "hexdeck-en",
          adapter_version: adapter.adapterVersion,
          subset: "set-slice-pilot",
          requests: adapter.requiredSurfaces!.map((surface) => ({
            id: `hexdeck-en:${surface}`,
            url: adapter.requestUrlForSurface!(surface),
          })),
        },
      ],
    });
    const runId = String(started.id);
    await collectFixtureEvidence(
      testEnv.CATALOGUE_DB,
      testEnv.EVIDENCE_OBJECTS,
      {
        async fetch(input: RequestInfo | URL) {
          const url = new Request(input).url;
          const body = bodies.get(url);
          if (body !== undefined)
            return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
          if (failure === "missing") return new Response("Injected image outage", { status: 404 });
          const bytes = Uint8Array.from(
            atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGP4/x8AAwAB//wl3FEAAAAASUVORK5CYII="),
            (character) => character.charCodeAt(0),
          );
          return new Response(bytes, { headers: { "content-type": "image/png" } });
        },
      } as Fetcher,
      runId,
    );
    const preparation = prepareNativeEvidence({
      runId,
      game: "riftbound",
      predecessor: "catrev_spine_000",
      key: `hexdeck-${failure}-candidate`,
    });
    if (failure === "mismatched") {
      await expect(preparation).rejects.toThrow("Review-required image digest conflicts with retained evidence");
      return;
    }
    const candidate = await preparation;
    const records = await nativeCandidateRecords(requiredString(candidate, "id"), ["cards", "printings"]);
    expect(records.cards ?? []).toHaveLength(0);
    expect(records.printings ?? []).toHaveLength(0);
    const proposals = (await reviewProposals(db).bind("hexdeck-en").all<{ id: string; reference: string }>()).results;
    expect(proposals).toHaveLength(2);
    const buff = proposals.find((proposal) => JSON.parse(proposal.reference)[0] === "cmpmw7kdx016hqg6xq59srhe8")!;
    const inspected = await inspectEntityProposal(db, buff.id);
    expect(inspected.status).toBe("unresolved");
    expect(inspected.evidence.source_images).toEqual([
      expect.objectContaining({
        association: "source_record",
        role: "front",
        content_sha256: "58da926e840907f0907f5858beecd27019c8274551b8282116f36d1c1a19f0c7",
      }),
    ]);
    expect(inspected.evidence.source_images[0]).not.toHaveProperty("content_object_key");
  },
);
