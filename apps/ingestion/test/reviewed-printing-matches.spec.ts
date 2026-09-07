import { expect, test } from "vitest";
import { installReconciliationSuite, post, get, collect, reconcile, approve } from "./reconciliation-helpers";

installReconciliationSuite();
const supplemental = { game: "one-piece", lineage: "limitless-one-piece-en", adapter: "fixture-one-piece-tabular@1" };

async function prepare(run: string, revision: string, key: string) {
  const created = await post("/v1/game-candidates", {
    ingestion_run_id: run,
    supported_game: "one-piece",
    expected_game_revision_id: revision,
    idempotency_key: key,
  });
  expect(created.response.status, JSON.stringify(created.document)).toBe(201);
  let candidate = (await get(`/v1/game-candidates/${created.document.id}`)).document;
  const deadline = Date.now() + 15000;
  while (candidate.state === "preparing" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    candidate = (await get(`/v1/game-candidates/${created.document.id}`)).document;
  }
  return candidate;
}

test.each([true, false])(
  "ten alternate observations with pinned decisions=%s retain bounded identity matching",
  async (reviewed) => {
    // Synthetic source and owner evidence exercise the production admission API;
    // these invented appearances are not the retained P-001 acceptance evidence.
    const seed = await reconcile((await collect("/reconciliation/canonical-official", "reviewed-seed")).id);
    const published = await approve(seed.document);
    expect(published.response.status, JSON.stringify(published.document)).toBe(200);
    const revision = String(published.document.resulting_revision_id);
    const cardId = (seed.document.cards as { id: string }[])[0]!.id;
    {
      for (const area of ["card_facts", "printing_details"]) {
        const designation = await post("/v1/source-authorities", {
          game: "one-piece",
          locale: "en",
          release_region: "OCEANIA",
          area,
          source_lineage: "limitless-one-piece-en",
          expected_generation: "0",
          rationale: "Synthetic unresolved matcher exercise",
          idempotency_key: `many-${area}`,
        });
        expect(designation.response.status).toBe(200);
      }
    }
    const ids = new Set<string>();
    if (reviewed)
      for (let index = 0; index < 10; index++) {
        const { id: _cardId, ...card } = (seed.document.cards as Record<string, unknown>[])[0]!;
        const {
          id: _printingId,
          card_id: _printingCard,
          ...printing
        } = (seed.document.printings as Record<string, unknown>[])[0]!;
        const created = await post("/v1/entity-proposals", {
          game: "one-piece",
          source_lineage: "limitless-one-piece-en",
          reference: JSON.stringify([`/supplemental/alternate-${index}`, null]),
          content: { card, printing },
          evidence: { attestation: "Synthetic owner inspection of this alternate." },
          idempotency_key: `many-proposal-${index}`,
        });
        expect(created.response.status, JSON.stringify(created.document)).toBe(201);
        const admitted = await post(`/v1/entity-proposals/${created.document.id}/decisions`, {
          action: "admit",
          expected_generation: "0",
          card_id: cardId,
          rationale: "Synthetic owner resolves this distinct alternate",
          exception: { scope: ["identity", "source_evidence"], attestation: "Synthetic scoped identity review." },
          idempotency_key: `many-admit-${index}`,
        });
        expect(admitted.response.status, JSON.stringify(admitted.document)).toBe(200);
        ids.add((admitted.document.history as { decision: { printing: { id: string } } }[])[0]!.decision.printing.id);
      }
    if (reviewed) expect(ids.size).toBe(10);
    const next = await collect("/reconciliation/canonical-tabular-many-alternates", "many-reviewed", supplemental);
    const candidate = await prepare(next.id, revision, "many-reviewed-prepare");
    expect(candidate, JSON.stringify(candidate)).toMatchObject(
      reviewed
        ? { state: "sealed" }
        : {
            state: "failed",
            failure_code: "printing_reconciliation_blocked",
            outcome: {
              diagnostics: expect.arrayContaining([
                expect.objectContaining({ code: "printing_match_insufficient_evidence" }),
              ]),
            },
          },
    );
  },
);
