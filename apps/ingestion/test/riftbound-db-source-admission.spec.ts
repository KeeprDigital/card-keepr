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

installReconciliationSuite({ directPreparation: true });

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
