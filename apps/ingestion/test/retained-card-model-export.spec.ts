import { expect, test } from "vitest";
import golden from "../../../acceptance/fixtures/retained-card-model-export.json" with { type: "json" };
import { buildCatalogueExport } from "../../../src/catalogue/export";
import { type CatalogueCandidate, canonicalJson, sha256, sha256Text } from "../../../src/catalogue/shared";

test("retained export reconstruction preserves every object byte from the pinned predecessor writer", async () => {
  expect(golden.baselineCommit).toBe("d0f6ccaec3ca248c2e117b193d6d0251a0cf23c7");
  expect(await sha256Text(canonicalJson(golden.candidate))).toBe(golden.candidateDigest);
  // Frozen historical input crosses the existing retained reconstruction boundary;
  // it is deliberately not decoded or filled as a current Catalogue Candidate.
  const built = await buildCatalogueExport(
    golden.candidate as unknown as CatalogueCandidate,
    golden.candidateDigest,
    golden.revisionId,
    golden.publishedAt,
  );
  expect(built.objects.map(({ key, byteLength, sha256 }) => ({ key, byteLength, sha256 }))).toEqual(golden.objects);
  for (const [index, object] of built.objects.entries()) {
    const body = object.body();
    const bytes = new Uint8Array(await new Response(body.readable).arrayBuffer());
    await body.completed;
    expect(bytes.byteLength).toBe(golden.objects[index]!.byteLength);
    expect(await sha256(bytes)).toBe(golden.objects[index]!.sha256);
  }
});

test.each(["art", "relationship", "printing_inapplicable"])(
  "retained aggregate export refuses expanded-only %s content",
  async (kind) => {
    const candidate = {
      ...golden.candidate,
      cards: golden.candidate.cards.map((card) => ({
        ...card,
        category: kind === "art" ? "art" : "gameplay",
        gameplay_applicability: kind === "art" ? "inapplicable" : "applicable",
        effective_rules_text: kind === "art" ? null : card.effective_rules_text,
        game_data: kind === "art" ? { ...card.game_data, attributes: {} } : card.game_data,
        related_cards: kind === "relationship" ? [{ kind: "shared_artwork", card_id: "card_art", evidence: [] }] : [],
      })),
      printings: golden.candidate.printings.map((printing) => ({
        ...printing,
        gameplay_applicability: kind === "art" || kind === "printing_inapplicable" ? "inapplicable" : "applicable",
        printed_rules_text: kind === "art" || kind === "printing_inapplicable" ? null : printing.printed_rules_text,
      })),
    } as CatalogueCandidate;
    await expect(
      buildCatalogueExport(candidate, golden.candidateDigest, golden.revisionId, golden.publishedAt),
    ).rejects.toThrow("Retained aggregate exports cannot encode art Cards or Card relationships.");
  },
);
