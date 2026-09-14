import { type CatalogueCard, type CardRelationship, canonicalJson } from "../shared";

export class CardRelationshipError extends Error {}

export type ObservedCardRelationship = {
  kind: "shared_artwork";
  target: { source_lineage: string; locator: string; variant_key: string | null };
};
export type CardRelationshipEvidence = ObservedCardRelationship & {
  printing_id: string;
  source_observation_id: string;
  artwork_fingerprint: string;
};

export function parseCardRelationships(value: unknown): ObservedCardRelationship[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8)
    throw new Error("Card relationships require at most eight evidenced targets.");
  return value.map((entry: unknown) => {
    if (
      !record(entry) ||
      entry.kind !== "shared_artwork" ||
      !record(entry.target) ||
      Object.keys(entry).some((key) => key !== "kind" && key !== "target") ||
      Object.keys(entry.target).some((key) => !["source_lineage", "locator", "variant_key"].includes(key)) ||
      typeof entry.target.source_lineage !== "string" ||
      !entry.target.source_lineage ||
      typeof entry.target.locator !== "string" ||
      !entry.target.locator ||
      entry.target.locator.length > 32768 ||
      !(
        entry.target.variant_key === null ||
        (typeof entry.target.variant_key === "string" && entry.target.variant_key.length > 0)
      )
    )
      throw new Error("A shared artwork relationship requires an exact retained Printing locator.");
    return {
      kind: "shared_artwork",
      target: {
        source_lineage: entry.target.source_lineage,
        locator: entry.target.locator,
        variant_key: entry.target.variant_key,
      },
    };
  });
}

/** Resolve only named, issued Printings after all Card/Printing allocations exist. */
export async function resolveCardRelationships(
  card: CatalogueCard,
  evidence: readonly CardRelationshipEvidence[],
  targetAt: (target: ObservedCardRelationship["target"]) => Promise<
    | {
        printingId: string;
        compatibility: { card_id: string; artwork_fingerprint: string };
        sourceObservationId: string;
      }
    | undefined
  >,
  cardAt: (id: string) => Promise<CatalogueCard | undefined>,
): Promise<readonly CardRelationship[]> {
  const relationships = new Map<string, CardRelationship>();
  for (const assertion of evidence) {
    const target = await targetAt(assertion.target);
    const related = target ? await cardAt(target.compatibility.card_id) : undefined;
    if (
      !target ||
      !related ||
      related.id === card.id ||
      related.game !== card.game ||
      related.game_data.profile !== card.game_data.profile ||
      (card.category === "art") === (related.category === "art") ||
      target.compatibility.artwork_fingerprint !== assertion.artwork_fingerprint
    )
      throw new CardRelationshipError(
        "Shared artwork must resolve distinct art and gameplay Cards through their evidenced issued Printings.",
      );
    const relation = relationships.get(related.id) ?? { kind: "shared_artwork", card_id: related.id, evidence: [] };
    const supporting = {
      source_observation_id: assertion.source_observation_id,
      printing_id: assertion.printing_id,
      related_printing_id: target.printingId,
      related_source_observation_id: target.sourceObservationId,
      artwork_fingerprint: assertion.artwork_fingerprint,
    };
    relationships.set(related.id, {
      ...relation,
      evidence: [
        ...new Map([...relation.evidence, supporting].map((value) => [canonicalJson(value), value])).values(),
      ].sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))),
    });
  }
  return [...relationships.values()].sort((a, b) => a.card_id.localeCompare(b.card_id));
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
