import { parsedOfficialArtworkIdentity } from "../adapters";
import {
  type Withdrawal,
  compatibilityFields,
  type ParsedCardPrintingObservation,
  type PrintingCompatibility,
} from "./reconciliation-observation";

export {
  compatibilityFields,
  parseReconciliationObservation,
} from "./reconciliation-observation";
export type {
  Memberships,
  ParsedCardPrintingObservation,
  ParsedOfficialErratumObservation,
  ParsedReconciliationObservation,
  PrintingCompatibility,
  ReconciliationWarning,
  Withdrawal,
} from "./reconciliation-observation";

export type ProvenancedWithdrawal = Withdrawal & {
  assertion: "withdrawn" | "reinstated";
  source_lineage: string;
  source_snapshot_id: string;
  source_observation_set_id: string;
  source_observation_id: string;
};

export function compatibilityFor(
  cardId: string,
  sourceLineage: string,
  observation: ParsedCardPrintingObservation,
): PrintingCompatibility {
  if (
    observation.observedCardAndPrinting.card === null ||
    observation.observedCardAndPrinting.printing === null ||
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
    rarity_normalized: observation.observedCardAndPrinting.printing.rarity.normalized,
    treatment: observation.treatment,
  };
}

export function isCompatible(left: PrintingCompatibility, right: PrintingCompatibility): boolean {
  // Source origin is provenance. Exact Card, artwork, printed fields, rarity
  // and treatment evidence establish compatibility across sources.
  return compatibilityFields.every((field) => field === "source_lineage" || left[field] === right[field]);
}

export function isGundamEnglishLineage(lineage: string): boolean {
  return lineage === "gundam-en-asia" || lineage === "gundam-en-us";
}

/** The profile establishes face meaning; adapter-local artwork labels are not
 * cross-source identifiers. Gundam also requires Product corroboration in the
 * reconciliation policy. Equal downloaded bytes are never consulted here. */
export function hasCrossSourceArtworkEvidence(observation: ParsedCardPrintingObservation): boolean {
  const card = observation.observedCardAndPrinting.card;
  const artwork =
    observation.artworkFingerprint === null ? null : parsedOfficialArtworkIdentity(observation.artworkFingerprint);
  if (!card || !artwork?.artwork_id || artwork.official_card_identity !== card.official_identity.value) return false;
  switch (card.game) {
    case "one-piece":
      return artwork.roles.join(",") === "front";
    case "fusion-world":
      return artwork.roles.join(",") === (card.game_data.attributes.card_type === "leader" ? "back,front" : "front");
    case "digimon":
      return artwork.roles.join(",") === "front";
    case "gundam":
      return artwork.roles.join(",") === "front";
  }
}
