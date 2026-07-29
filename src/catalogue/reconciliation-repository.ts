import type { FixtureCard } from "./fixture";
import {
  compatibilityFields,
  isGundamEnglishLineage,
  type PrintingCompatibility,
} from "./reconciliation-model";
import { canonicalJson } from "./serialization";

export type ReconciledCardRow = {
  id: string;
  supported_game: string;
  official_identity_kind: string;
  official_identity_value: string;
  first_revision_id: string;
  last_observed_revision_id: string;
  withdrawn: number;
  withdrawal_revision_id: string | null;
  withdrawal_evidence_json: string | null;
};

export type ReconciledPrintingRow = PrintingCompatibility & {
  id: string;
  first_revision_id: string;
  last_observed_revision_id: string;
  withdrawn: number;
  withdrawal_revision_id: string | null;
  withdrawal_evidence_json: string | null;
};

const compatibilityPredicate = compatibilityFields
  .map((field) => `${field} IS ?`)
  .join(" AND ");

export async function existingCard(
  database: D1Database,
  input: {
    supportedGame: string;
    identityKind: string;
    identityValue: string;
  },
): Promise<ReconciledCardRow | null> {
  return database
    .prepare(
      `SELECT * FROM reconciled_cards
       WHERE supported_game = ?
         AND official_identity_kind = ?
         AND official_identity_value = ?`,
    )
    .bind(input.supportedGame, input.identityKind, input.identityValue)
    .first<ReconciledCardRow>();
}

export async function compatiblePrintings(
  database: D1Database,
  compatibility: PrintingCompatibility,
): Promise<ReconciledPrintingRow[]> {
  const crossLocale = isGundamEnglishLineage(
    compatibility.source_lineage,
  );
  const result = await database
    .prepare(
      crossLocale
        ? `SELECT * FROM reconciled_printings
           WHERE card_id IS ?
             AND source_lineage IN ('gundam-en-asia', 'gundam-en-us')
             AND artwork_fingerprint IS ?
             AND printed_fields_digest IS ?
             AND rarity_normalized IS ?
             AND treatment IS ?
           ORDER BY id`
        : `SELECT * FROM reconciled_printings
           WHERE ${compatibilityPredicate}
           ORDER BY id`,
    )
    .bind(
      ...(crossLocale
        ? [
            compatibility.card_id,
            compatibility.artwork_fingerprint,
            compatibility.printed_fields_digest,
            compatibility.rarity_normalized,
            compatibility.treatment,
          ]
        : compatibilityValues(compatibility)),
    )
    .all<ReconciledPrintingRow>();
  return result.results;
}

export async function gundamCrossLocaleEvidenceCompatible(
  database: D1Database,
  printing: ReconciledPrintingRow,
  proposedLineage: string,
  proposedVariantKey: string | null,
  proposedProductCodes: readonly string[],
): Promise<boolean> {
  if (
    printing.source_lineage === proposedLineage ||
    !isGundamEnglishLineage(printing.source_lineage) ||
    !isGundamEnglishLineage(proposedLineage)
  ) {
    return true;
  }
  if (proposedVariantKey === null) return false;
  const [variants, products] = await Promise.all([
    database
      .prepare(
        `SELECT DISTINCT variant_key
         FROM reconciled_printing_locators
         WHERE printing_id = ? AND source_lineage = ?
         ORDER BY variant_key`,
      )
      .bind(printing.id, printing.source_lineage)
      .all<{ variant_key: string | null }>(),
    database
      .prepare(
        `SELECT DISTINCT relationship_value
         FROM reconciled_printing_memberships
         WHERE printing_id = ?
           AND source_lineage = ?
           AND relationship_kind = 'product'
           AND current = 1
         ORDER BY relationship_value`,
      )
      .bind(printing.id, printing.source_lineage)
      .all<{ relationship_value: string }>(),
  ]);
  const priorVariantKeys = variants.results.map((row) => row.variant_key);
  const priorProductCodes = products.results.map(
    (row) => row.relationship_value,
  );
  return (
    priorVariantKeys.length > 0 &&
    priorVariantKeys.every((value) => value === proposedVariantKey) &&
    canonicalJson(priorProductCodes) ===
      canonicalJson([...new Set(proposedProductCodes)].sort())
  );
}

export async function printingsWithAppearance(
  database: D1Database,
  compatibility: PrintingCompatibility,
): Promise<ReconciledPrintingRow[]> {
  const rows = await database
    .prepare(
      `SELECT * FROM reconciled_printings
       WHERE card_id = ?
         AND artwork_fingerprint = ?
         AND treatment IS ?
       ORDER BY id`,
    )
    .bind(
      compatibility.card_id,
      compatibility.artwork_fingerprint,
      compatibility.treatment,
    )
    .all<ReconciledPrintingRow>();
  return rows.results;
}

export async function printingAtLocator(
  database: D1Database,
  sourceLineage: string,
  locator: string,
): Promise<ReconciledPrintingRow | null> {
  return database
    .prepare(
      `SELECT printing.*
       FROM reconciled_printing_locators AS locator
       JOIN reconciled_printings AS printing
         ON printing.id = locator.printing_id
       WHERE locator.source_lineage = ? AND locator.locator = ?`,
    )
    .bind(sourceLineage, locator)
    .first<ReconciledPrintingRow>();
}

export async function hasOtherGundamLocaleEvidence(
  database: D1Database,
  printingId: string,
  sourceLineage: string,
): Promise<boolean> {
  const counterpart =
    sourceLineage === "gundam-en-asia"
      ? "gundam-en-us"
      : sourceLineage === "gundam-en-us"
        ? "gundam-en-asia"
        : null;
  if (counterpart === null) return true;
  const row = await database
    .prepare(
      `SELECT printing_id
       FROM reconciled_printing_locators
       WHERE printing_id = ? AND source_lineage = ?
       LIMIT 1`,
    )
    .bind(printingId, counterpart)
    .first<{ printing_id: string }>();
  return row !== null;
}

export async function canonicalCardConflict(
  database: D1Database,
  cardId: string,
  proposed: Omit<FixtureCard, "id">,
  sourceLineage: string,
): Promise<string | null> {
  const row = await database
    .prepare(
      `SELECT card.document_json
       FROM catalogue_state AS state
       JOIN revision_cards AS card
         ON card.catalogue_revision_id = state.current_revision_id
       WHERE state.singleton = 1 AND card.card_id = ?`,
    )
    .bind(cardId)
    .first<{ document_json: string }>();
  if (row === null) return null;
  const current = JSON.parse(row.document_json) as Record<string, unknown>;
  const currentCanonical = {
    game: current.game,
    official_identity: current.official_identity,
    name: current.name,
    effective_rules_text: current.effective_rules_text,
    game_data: current.game_data,
  };
  const proposedCanonical = {
    game: proposed.game,
    official_identity: proposed.official_identity,
    name: proposed.name,
    effective_rules_text: proposed.effective_rules_text,
    game_data: proposed.game_data,
  };
  if (canonicalJson(currentCanonical) === canonicalJson(proposedCanonical)) {
    return null;
  }
  const authorities = await database
    .prepare(
      `SELECT DISTINCT source_lineage
       FROM reconciled_card_observations
       WHERE card_id = ? AND current = 1`,
    )
    .bind(cardId)
    .all<{ source_lineage: string }>();
  return authorities.results.length > 0 &&
    authorities.results.every(
      (authority) => authority.source_lineage === sourceLineage,
    )
    ? null
    : "The retained Card facts conflict across authoritative source lineages and no deterministic authority rule resolves them.";
}

function compatibilityValues(
  compatibility: PrintingCompatibility,
): (string | null)[] {
  return compatibilityFields.map((field) => compatibility[field]);
}
