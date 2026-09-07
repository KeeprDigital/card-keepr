import { type CataloguePrinting, type CatalogueStore, canonicalJson, sha256Text } from "../shared";
import { nativePredecessorGameCandidateStatement } from "./game-candidate-repository";
import { nativePriorPrintingLocatorsStatement } from "./native-printing-locators-repository";

export function retainPrintingLocator(
  previous: CataloguePrinting | undefined,
  evidence: NonNullable<CataloguePrinting["locator_evidence"]>[number],
) {
  const locators = [...(previous?.locator_evidence ?? [])];
  if (
    !locators.some(
      (old) =>
        old.source_lineage === evidence.source_lineage &&
        old.locator === evidence.locator &&
        old.variant_key === evidence.variant_key,
    )
  )
    locators.push(evidence);
  locators.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  if (
    locators.length > 128 ||
    locators.some((entry) => entry.locator.length > 32768) ||
    new TextEncoder().encode(canonicalJson(locators)).byteLength > 131072
  )
    throw new Error("reconciliation_capacity_exceeded: one Printing has too much retained locator evidence.");
  return locators;
}

/** Undefined selects legacy lookup; an empty native result must never fall back. */
export async function nativePrintingsAtLocator(
  db: CatalogueStore,
  prior: { preparationId: string; revision: string; game: string; cardId: string; through: number },
  lineage: string,
  locator: string,
): Promise<{ id: string }[] | undefined> {
  const candidate = await nativePredecessorGameCandidateStatement(db, prior.revision, prior.game).first<{
    id: string;
  }>();
  if (!candidate) return undefined;
  // Prior-state seeding verifies the exact member's manifest partitions before
  // retaining this immutable, card-indexed view. Read only its completed prefix.
  const rows = (
    await nativePriorPrintingLocatorsStatement(
      db,
      prior.preparationId,
      await sha256Text(prior.cardId),
      prior.through,
      lineage,
      locator,
    ).all<{ content: string; sha256: string }>()
  ).results;
  if (rows.length > 8) throw new Error("reconciliation_capacity_exceeded: one locator matches too many Printings.");
  const ids = new Set<string>();
  for (const row of rows) {
    if ((await sha256Text(row.content)) !== row.sha256)
      throw new Error("Prior Printing locator evidence failed integrity verification.");
    const value = JSON.parse(row.content).value as CataloguePrinting;
    if (value.card_id !== prior.cardId) throw new Error("Prior Printing locator evidence has another Card identity.");
    ids.add(value.id);
  }
  return [...ids].sort().map((id) => ({ id }));
}
