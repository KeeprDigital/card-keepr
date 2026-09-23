import { fixtureAcquisitionBudget } from "../../../test/support/fixture-evidence-plan";
import { expect, test } from "vitest";
import facets from "../../../acceptance/fixtures/real-sources/2026-09-14-riftbound-db/raw/facets.json?raw";
import promo from "../../../acceptance/fixtures/real-sources/2026-09-14-riftbound-db/raw/pr-page-1-size-3.json?raw";
import bird from "../../../acceptance/fixtures/real-sources/2026-09-14-riftbound-db/raw/bird-page-1-size-3.json?raw";
import { catalogueStore } from "../../../src/catalogue/shared";
import { startEvidenceRun } from "../../../src/catalogue/source-evidence";
import { requiredSourceAdapter } from "../../../src/catalogue/adapters";
import { collectFixtureEvidence } from "../../../test/support/fixture-evidence-plan";
import { installReconciliationSuite, requiredString, testEnv } from "./reconciliation-helpers";
import { prepareNativeEvidence } from "./native-publication-helpers";
import { nativeCandidateRecords } from "./native-candidate-helpers";
import { inspectEntityProposal } from "../../../src/catalogue/reconciliation/entity-admission";
import { reviewProposals } from "./query-helpers/source-admission-evidence";
import {
  syntheticRiftboundDbCardsPage,
  syntheticRiftboundDbRecords,
} from "../../../test/support/synthetic-riftbound-db-pages.mjs";

installReconciliationSuite({ directPreparation: true });

// The census root is the retained facets response (11 set buckets). PR carries
// the three retained promo records; OGN carries the retained Eclipse Herald and
// Anivia plus 80 synthetic copies of Anivia so the bucket spans two pages; the
// other nine buckets are empty. Every front is an injected outage, so this
// proves discovery, parent-checked pages and retained review records, not
// image coverage.
test("the Riftbound DB census follows every facet bucket and page and retains every record for owner review", async () => {
  const adapter = requiredSourceAdapter("riftbound-db-en@1");
  const db = catalogueStore(testEnv.CATALOGUE_DB);
  const census = (set: string, page: number) =>
    `https://www.riftbound-db.com/api/cards?set=${set}&page=${page}&pageSize=80`;
  const [eclipse, anivia] = JSON.parse(bird).cards.slice(1);
  const synthetic = syntheticRiftboundDbRecords(anivia, 80, "ogn");
  const buckets: Record<string, unknown[][]> = {
    PR: [JSON.parse(promo).cards],
    OGN: [[eclipse, anivia, ...synthetic.slice(0, 78)], synthetic.slice(78)],
  };
  const bodies = new Map<string, string>([[adapter.requestUrlForSurface!("facets"), facets]]);
  for (const set of JSON.parse(facets).sets as string[]) {
    const pages = buckets[set] ?? [[]];
    const total = pages.flat().length;
    pages.forEach((cards, index) =>
      bodies.set(census(set, index + 1), syntheticRiftboundDbCardsPage({ page: index + 1, total, cards })),
    );
  }
  const started = await startEvidenceRun(db, {
    acquisition_budget: fixtureAcquisitionBudget,
    idempotency_key: "riftbound-db-census",
    plans: [
      {
        supported_game: "riftbound",
        source_lineage: "riftbound-db-en",
        adapter_version: adapter.adapterVersion,
        subset: "set-census",
        requests: [{ id: "riftbound-db-en:set-census", url: adapter.requestUrlForSurface!("facets") }],
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
        const body = bodies.get(url);
        if (body !== undefined) return new Response(body, { headers: { "content-type": "application/json" } });
        return new Response("Injected image outage", { status: 404 });
      },
    } as Fetcher,
    runId,
  );
  expect(requested.filter((url) => bodies.has(url)).sort()).toEqual([...bodies.keys()].sort());
  // Three pinned promo fronts on OpenRift and Eclipse Herald's pinned Riot front;
  // Anivia's and the synthetic records' Riot-hosted fronts are not fetched.
  expect(requested.filter((url) => !bodies.has(url))).toHaveLength(4);
  const candidate = await prepareNativeEvidence({
    runId,
    game: "riftbound",
    predecessor: "catrev_spine_000",
    key: "riftbound-db-census-candidate",
  });
  const records = await nativeCandidateRecords(requiredString(candidate, "id"), ["cards", "printings"]);
  expect(records.cards ?? []).toHaveLength(0);
  expect(records.printings ?? []).toHaveLength(0);
  const proposals = (await reviewProposals(db).bind("riftbound-db-en").all<{ id: string; reference: string }>())
    .results;
  expect(proposals).toHaveLength(85);
  const last = proposals.find((proposal) => JSON.parse(proposal.reference)[0] === "synthetic-ogn-80")!;
  const inspected = await inspectEntityProposal(db, last.id);
  expect(inspected.status).toBe("unresolved");
  expect(inspected.evidence.source_membership).toEqual({ set_id: "OGN", local_id: "979" });
});

test.each(["missing", "mismatched"])(
  "Riftbound DB %s images distinguish tolerated absence from contradictory retained bytes",
  async (failure) => {
    const adapter = requiredSourceAdapter("riftbound-db-en@1");
    const db = catalogueStore(testEnv.CATALOGUE_DB);
    const bodies = new Map([
      [adapter.requestUrlForSurface!("facets"), facets],
      [adapter.requestUrlForSurface!("promo-page"), promo],
      [adapter.requestUrlForSurface!("bird-page"), bird],
    ]);
    const started = await startEvidenceRun(db, {
      acquisition_budget: fixtureAcquisitionBudget,
      idempotency_key: "riftbound-db-missing-images",
      plans: [
        {
          supported_game: "riftbound",
          source_lineage: "riftbound-db-en",
          adapter_version: adapter.adapterVersion,
          subset: "promo-overlap-pilot",
          requests: adapter.requiredSurfaces!.map((surface) => ({
            id: `riftbound-db-en:${surface}`,
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
          if (body !== undefined) return new Response(body, { headers: { "content-type": "application/json" } });
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
      key: "riftbound-db-outage-candidate",
    });
    if (failure === "mismatched") {
      await expect(preparation).rejects.toThrow("Review-required image digest conflicts with retained evidence");
      return;
    }
    const candidate = await preparation;
    const records = await nativeCandidateRecords(requiredString(candidate, "id"), ["cards", "printings"]);
    expect(records.cards ?? []).toHaveLength(0);
    expect(records.printings ?? []).toHaveLength(0);
    const proposals = (await reviewProposals(db).bind("riftbound-db-en").all<{ id: string; reference: string }>())
      .results;
    expect(proposals).toHaveLength(5);
    const selected = proposals.find(
      (proposal) => JSON.parse(proposal.reference)[0] === "openrift-019e1fea-0113-7f38-b59d-23cab5997383",
    )!;
    const inspected = await inspectEntityProposal(db, selected.id);
    expect(inspected.status).toBe("unresolved");
    expect(inspected.evidence.source_images).toEqual([
      expect.objectContaining({
        association: "source_record",
        role: "front",
        content_sha256: "7017a24aedbfefa54ada92f08b0a257b6b41fd7af1f2403ef0688bb055bc510b",
      }),
    ]);
    expect(inspected.evidence.source_images[0]).not.toHaveProperty("content_object_key");
  },
);
