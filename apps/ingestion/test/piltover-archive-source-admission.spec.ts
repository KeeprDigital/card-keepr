import { fixtureAcquisitionBudget } from "../../../test/support/fixture-evidence-plan";
import { expect, test } from "vitest";
import gallery from "../../../acceptance/fixtures/real-sources/2026-09-21-piltover-archive/raw/gallery-page-1.html?raw";
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
  "Piltover Archive %s fronts distinguish tolerated absence from contradictory retained bytes",
  async (failure) => {
    const adapter = requiredSourceAdapter("piltover-archive-en@1");
    const db = catalogueStore(testEnv.CATALOGUE_DB);
    const galleryUrl = adapter.requestUrlForSurface!("gallery");
    const started = await startEvidenceRun(db, {
      acquisition_budget: fixtureAcquisitionBudget,
      idempotency_key: `piltover-archive-${failure}-images`,
      plans: [
        {
          supported_game: "riftbound",
          source_lineage: "piltover-archive-en",
          adapter_version: adapter.adapterVersion,
          subset: "promo-lead-pilot",
          requests: [{ id: "piltover-archive-en:gallery", url: galleryUrl }],
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
          if (url === galleryUrl)
            return new Response(gallery, { headers: { "content-type": "text/html; charset=utf-8" } });
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
      key: `piltover-archive-${failure}-candidate`,
    });
    if (failure === "mismatched") {
      await expect(preparation).rejects.toThrow("Review-required image digest conflicts with retained evidence");
      return;
    }
    const candidate = await preparation;
    const records = await nativeCandidateRecords(requiredString(candidate, "id"), ["cards", "printings"]);
    expect(records.cards ?? []).toHaveLength(0);
    expect(records.printings ?? []).toHaveLength(0);
    const proposals = (await reviewProposals(db).bind("piltover-archive-en").all<{ id: string; reference: string }>())
      .results;
    expect(proposals).toHaveLength(2);
    const lead = proposals.find(
      (proposal) => JSON.parse(proposal.reference)[0] === "a60d2063-be1a-4ee5-a745-784eef4ed8b1",
    )!;
    const inspected = await inspectEntityProposal(db, lead.id);
    expect(inspected.status).toBe("unresolved");
    expect(inspected.evidence.source_images).toEqual([
      expect.objectContaining({
        association: "source_record",
        role: "front",
        content_sha256: "b96e5881f9ca253550bf2aa124189a32097c3a5caf28adcbb18433f505c2a4df",
      }),
    ]);
    expect(inspected.evidence.source_images[0]).not.toHaveProperty("content_object_key");
  },
);
