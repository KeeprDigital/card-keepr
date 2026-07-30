import type { FixtureCard } from "./fixture";
import type { Withdrawal } from "./reconciliation-observation";
import {
  compatibilityFields,
  type ParsedReconciliationObservation,
  type PrintingCompatibility,
} from "./reconciliation-observation";
import { canonicalJson, sha256Text } from "./serialization";

export {
  compatibilityFields,
  parseReconciliationObservation,
} from "./reconciliation-observation";
export type {
  Memberships,
  ParsedReconciliationObservation,
  PrintingCompatibility,
  ReconciliationWarning,
  Withdrawal,
} from "./reconciliation-observation";

export type ProvenancedWithdrawal = Withdrawal & {
  assertion: "withdrawn";
  source_lineage: string;
  source_snapshot_id: string;
  source_observation_set_id: string;
  source_observation_id: string;
};

export async function cardIdFor(
  card: Omit<FixtureCard, "id">,
): Promise<string> {
  return `card_${(
    await sha256Text(
      canonicalJson({
        supported_game: card.game,
        official_identity: card.official_identity,
      }),
    )
  ).slice(0, 32)}`;
}

export async function printingIdFor(
  compatibility: PrintingCompatibility,
): Promise<string> {
  return `printing_${(
    await sha256Text(canonicalJson(compatibility))
  ).slice(0, 32)}`;
}

export function compatibilityFor(
  cardId: string,
  sourceLineage: string,
  observation: ParsedReconciliationObservation,
): PrintingCompatibility {
  if (
    observation.candidateWithoutIdentities.printing === null ||
    observation.artworkFingerprint === null ||
    observation.printedFieldsDigest === null
  ) {
    throw new Error("A Card without a Printing has no compatibility tuple.");
  }
  return {
    card_id: cardId,
    source_lineage: sourceLineage,
    artwork_fingerprint: observation.artworkFingerprint,
    printed_fields_digest: observation.printedFieldsDigest,
    rarity_normalized:
      observation.candidateWithoutIdentities.printing.rarity.normalized,
    treatment: observation.treatment,
  };
}

export function isCompatible(
  left: PrintingCompatibility,
  right: PrintingCompatibility,
): boolean {
  return compatibilityFields.every(
    (field) =>
      left[field] === right[field] ||
      (field === "source_lineage" &&
        isGundamEnglishLineage(left.source_lineage) &&
        isGundamEnglishLineage(right.source_lineage)),
  );
}

export function isGundamEnglishLineage(lineage: string): boolean {
  return lineage === "gundam-en-asia" || lineage === "gundam-en-us";
}
