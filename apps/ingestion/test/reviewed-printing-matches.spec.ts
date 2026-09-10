import { expect, test } from "vitest";
import { nativeCandidateRecords } from "./native-candidate-helpers";
import {
  approveNativeCandidateThroughBinding as approveNativeCandidate,
  prepareNativeCandidateThroughBinding as prepareNativeCandidate,
} from "./native-publication-helpers";
import { collect, get, installReconciliationSuite, post } from "./reconciliation-helpers";

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
    const source = await collect("/reconciliation/canonical-official", "reviewed-seed");
    const seed = await prepareNativeCandidate(source.id, "one-piece", "catrev_spine_000", "reviewed-candidate");
    const records = await nativeCandidateRecords(String(seed.id));
    const published = await approveNativeCandidate(seed, "reviewed-publication");
    expect(published.response.status, JSON.stringify(published.document)).toBe(200);
    const revision = String(published.document.resulting_revision_id);
    const cardId = (records.cards as { id: string }[])[0]!.id;
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
    const ids = new Set<string>();
    if (reviewed)
      for (let index = 0; index < 10; index++) {
        const { id: _cardId, ...card } = (records.cards as Record<string, unknown>[])[0]!;
        const {
          id: _printingId,
          card_id: _printingCard,
          ...printing
        } = (records.printings as Record<string, unknown>[])[0]!;
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

test.each(["known-first", "known-last", "conflict"])(
  "reviewed same-Printing unknowns preserve known facts: %s",
  async (mode) => {
    const conflict = mode === "conflict";
    const source = await collect("/reconciliation/canonical-official", "known-seed");
    const seed = await prepareNativeCandidate(source.id, "one-piece", "catrev_spine_000", "known-candidate");
    const records = await nativeCandidateRecords(String(seed.id));
    const published = await approveNativeCandidate(seed, "known-publication");
    expect(published.response.status).toBe(200);
    const revision = String(published.document.resulting_revision_id);
    const { id: _cardId, ...card } = (records.cards as Record<string, unknown>[])[0]!;
    const {
      id: printingId,
      card_id: _printingCard,
      ...printing
    } = (records.printings as Record<string, unknown>[])[0]!;
    for (const area of ["card_facts", "printing_details"])
      expect(
        (
          await post("/v1/source-authorities", {
            game: "one-piece",
            locale: "en",
            release_region: "OCEANIA",
            area,
            source_lineage: "limitless-one-piece-en",
            expected_generation: "0",
            rationale: "Synthetic complementary source test",
            idempotency_key: `known-${area}`,
          })
        ).response.status,
      ).toBe(200);
    for (let index = 0; index < 10; index++) {
      const proposal = await post("/v1/entity-proposals", {
        game: "one-piece",
        source_lineage: "limitless-one-piece-en",
        reference: JSON.stringify([`/supplemental/alternate-${index}`, null]),
        content: { card, printing },
        evidence: { attestation: "Synthetic source alias review." },
        idempotency_key: `known-${index}`,
      });
      expect(proposal.response.status).toBe(201);
      const linked = await post(`/v1/entity-proposals/${proposal.document.id}/decisions`, {
        action: "link",
        expected_generation: "0",
        printing_id: printingId,
        rationale: "Synthetic aliases depict the same Printing",
        exception: { scope: ["identity", "source_evidence"], attestation: "Synthetic identity review." },
        idempotency_key: `known-link-${index}`,
      });
      expect(linked.response.status, JSON.stringify(linked.document)).toBe(200);
    }
    const run = await collect(
      `/reconciliation/canonical-tabular-unknown-${mode}-many-alternates`,
      "known-refresh",
      supplemental,
    );
    const candidate = await prepare(run.id, revision, "known-prepare");
    if (conflict) {
      expect(candidate, JSON.stringify(candidate)).toMatchObject({
        state: "failed",
        outcome: {
          diagnostics: expect.arrayContaining([expect.objectContaining({ code: "printing_match_contradictory" })]),
        },
      });
      return;
    }
    expect(candidate, JSON.stringify(candidate)).toMatchObject({ state: "sealed" });
    const partitions = (await get(`/v1/game-candidates/${candidate.id}/partitions`)).document.partitions as {
      ordinal: number;
      kind: string;
    }[];
    const values = [];
    for (const partition of partitions.filter((p) => p.kind === "printings")) {
      values.push(
        ...((await get(`/v1/game-candidates/${candidate.id}/partitions/${partition.ordinal}`)).document
          .records as Record<string, unknown>[]),
      );
    }
    expect(values).toHaveLength(1);
    expect(values[0]).toMatchObject({
      id: printingId,
      rarity: printing.rarity,
      printed_rules_text: printing.printed_rules_text,
    });
  },
);
