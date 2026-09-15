import { expect, test } from "vitest";
import { collectFixtureEvidence } from "../../../test/support/fixture-evidence-plan";
import { reconciliationSourceDocument } from "../../../test/support/fake-publisher/reconciliation-documents";
import { get, post, postFixtureEvidence, installReconciliationSuite, testEnv } from "./reconciliation-helpers";
import { nativeCandidateRecords, waitForNativeCandidate } from "./native-candidate-helpers";
import { approveNativeCandidate, prepareNativeEvidence } from "./native-publication-helpers";

installReconciliationSuite({ directPreparation: true });

type Observation = Record<string, unknown> & {
  identity_evidence: { locator: string; variant_key: string; printed_fields_digest: string };
};

function sourceObservation(supplementary: boolean) {
  const source = reconciliationSourceDocument("inspection-base", "discovery", "https://official-source.invalid/linked");
  const observation = structuredClone(source!.cards![0]!) as unknown as Observation;
  observation.memberships = { products: [], distribution_contexts: [], source_buckets: [] };
  delete observation.product_release_catalogue;
  observation.identity_evidence.locator = supplementary ? "/supplementary/reviewed" : "/official/reviewed";
  observation.identity_evidence.variant_key = "base";
  // Two source representations of the explicitly reviewed same appearance.
  // Their different raw field digests must remain distinct even though the
  // normalized canonical facts agree. This isolates locator compatibility.
  observation.identity_evidence.printed_fields_digest = supplementary ? "supplementary-fields" : "official-fields";
  return observation;
}

async function prepare(both: boolean, key: string, predecessor = "catrev_spine_000") {
  const sources = [
    { lineage: "one-piece-en", adapter: "fixture-one-piece-json@3", supplementary: false },
    ...(both ? [{ lineage: "limitless-one-piece-en", adapter: "fixture-limitless-json@1", supplementary: true }] : []),
  ];
  const started = await postFixtureEvidence({
    plans: sources.map((source) => ({
      supported_game: "one-piece",
      source_lineage: source.lineage,
      adapter_version: source.adapter,
      requests: [{ id: `${source.lineage}:linked`, url: `https://official-source.invalid/${source.lineage}` }],
    })),
    idempotency_key: key,
  });
  expect(started.response.status).toBe(201);
  const transport = {
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const request = new Request(input, init);
      const source = sources.find((entry) => new URL(request.url).pathname === `/${entry.lineage}`);
      return source
        ? Response.json({ cards: [sourceObservation(source.supplementary)] })
        : testEnv.OFFICIAL_SOURCE_TRANSPORT.fetch(input, init);
    },
  } as Fetcher;
  await collectFixtureEvidence(testEnv.CATALOGUE_DB, testEnv.EVIDENCE_OBJECTS, transport, String(started.document.id));
  const candidate = await prepareNativeEvidence({
    runId: String(started.document.id),
    game: "one-piece",
    predecessor,
    key: `${key}-candidate`,
  });
  return { candidate, records: await nativeCandidateRecords(String(candidate.id), ["cards", "printings"]) };
}

test.each([false, true])(
  "reviewed source locators retain compatibility through native refresh (carried: %s)",
  async (carried) => {
    const official = await prepare(false, "linked-official");
    expect(official.records.printings).toHaveLength(1);
    const printing = official.records.printings![0]!;
    const original = await approveNativeCandidate(official.candidate, "linked-official-publish");
    const revision = String(original.document.resulting_revision_id);
    const intake = await prepare(true, "linked-intake", revision);
    const proposals = (await get("/v1/entity-proposals?game=one-piece")).document.proposals as {
      id: string;
      source_lineage: string;
    }[];
    const supplemental = proposals.find((proposal) => proposal.source_lineage === "limitless-one-piece-en")!;
    expect(supplemental).toBeDefined();
    expect(
      (
        await post(`/v1/game-candidates/${intake.candidate.id}/abandon`, {
          generation: intake.candidate.generation,
          idempotency_key: "linked-abandon-intake",
        })
      ).response.status,
    ).toBe(202);
    await waitForNativeCandidate(String(intake.candidate.id), "abandoned");
    const decision = await post(`/v1/entity-proposals/${supplemental.id}/decisions`, {
      action: "link",
      printing_id: printing.id,
      expected_generation: "0",
      rationale: "Synthetic owner comparison establishes the same appearance despite different source representations.",
      exception: { scope: ["identity"], attestation: "Synthetic reviewed front, frame and printed markings match." },
      idempotency_key: "linked-reviewed-appearance",
    });
    expect(decision.response.status, JSON.stringify(decision.document)).toBe(200);
    const linked = await prepare(true, "linked-both", revision);
    expect(linked.records.printings).toHaveLength(1);
    expect(linked.records.printings![0]).toMatchObject({ id: printing.id, rarity: printing.rarity });
    expect(linked.records.printings![0]!.locator_evidence).toHaveLength(2);
    const publication = await approveNativeCandidate(linked.candidate, "linked-both-publish");
    let predecessor = String(publication.document.resulting_revision_id);
    if (carried) {
      const officialOnly = await prepare(false, "linked-carry-supplementary", predecessor);
      expect(officialOnly.records.printings![0]!.locator_evidence).toHaveLength(2);
      const carriedPublication = await approveNativeCandidate(officialOnly.candidate, "linked-carry-publish");
      predecessor = String(carriedPublication.document.resulting_revision_id);
    }
    const refreshed = await prepare(true, "linked-refresh", predecessor);
    expect(refreshed.records.printings).toHaveLength(1);
    expect(refreshed.records.printings![0]).toMatchObject({ id: printing.id, rarity: printing.rarity });
    expect(refreshed.records.cards!.map((card) => card.id)).toEqual(official.records.cards!.map((card) => card.id));
    expect(refreshed.records.printings![0]!.locator_evidence).toHaveLength(2);
    expect((await get(`/v1/entity-proposals/${supplemental.id}`)).document.history).toEqual(decision.document.history);
  },
);
