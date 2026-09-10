import {
  type CatalogueCard,
  type CataloguePrinting,
  type CatalogueStore,
  canonicalJson,
  repositoryStatements,
} from "../shared";
import { gamePredecessorCandidateSql } from "./game-candidate-predecessor-repository";
import type { NativeSourceHistory } from "./native-source-history-state";
import type { PrintingCompatibility } from "./reconciliation-model";

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

export async function existingCard(
  database: CatalogueStore,
  input: {
    supportedGame: string;
    identityKind: string;
    identityValue: string;
  },
): Promise<ReconciledCardRow | null> {
  return repositoryStatements(database)
    .prepare(
      `SELECT * FROM reconciled_cards
       WHERE supported_game = ?
         AND official_identity_kind = ?
         AND official_identity_value = ?`,
    )
    .bind(input.supportedGame, input.identityKind, input.identityValue)
    .first<ReconciledCardRow>();
}

export function publishedCardPresentStatement(
  database: CatalogueStore,
  game: string,
  preparation: string,
  revision: string,
) {
  return repositoryStatements(database)
    .prepare(`SELECT 1 AS present FROM reconciled_cards WHERE supported_game = ?1
      UNION ALL SELECT 1 FROM publication_read_entities WHERE kind='cards'
        AND candidate_id=${gamePredecessorCandidateSql("?3", "?1", "?2")} LIMIT 1`)
    .bind(game, preparation, revision);
}

export async function compatiblePrintings(
  database: CatalogueStore,
  compatibility: PrintingCompatibility,
): Promise<ReconciledPrintingRow[]> {
  const result = await repositoryStatements(database)
    .prepare(`SELECT * FROM reconciled_printings
      WHERE card_id IS ? AND artwork_fingerprint IS ? AND printed_fields_digest IS ?
        AND rarity_normalized IS ? AND treatment IS ? ORDER BY id LIMIT 9`)
    .bind(
      compatibility.card_id,
      compatibility.artwork_fingerprint,
      compatibility.printed_fields_digest,
      compatibility.rarity_normalized,
      compatibility.treatment,
    )
    .all<ReconciledPrintingRow>();
  return boundedPrintingMatches(result.results);
}

export async function printingsWithAppearance(
  database: CatalogueStore,
  compatibility: PrintingCompatibility,
): Promise<ReconciledPrintingRow[]> {
  const rows = await repositoryStatements(database)
    .prepare(
      `SELECT * FROM reconciled_printings
       WHERE card_id = ?
         AND artwork_fingerprint = ?
         AND treatment IS ?
       ORDER BY id LIMIT 9`,
    )
    .bind(compatibility.card_id, compatibility.artwork_fingerprint, compatibility.treatment)
    .all<ReconciledPrintingRow>();
  return boundedPrintingMatches(rows.results);
}

export async function printingAtLocatorVariant(
  database: CatalogueStore,
  sourceLineage: string,
  locator: string,
  variantKey: string | null,
): Promise<ReconciledPrintingRow | null> {
  const row = await repositoryStatements(database)
    .prepare(
      `SELECT printing.*, mapping.evidence_json AS mapped_evidence_json
       FROM reconciled_printing_locators AS locator
       JOIN reconciled_printings AS printing
         ON printing.id = locator.printing_id
       LEFT JOIN canonical_source_mappings AS mapping
         ON mapping.entity_id = printing.id AND mapping.source_lineage = locator.source_lineage
         AND mapping.locator = locator.locator AND mapping.variant_key IS locator.variant_key
         AND EXISTS (SELECT 1 FROM ingestion_run_current AS run WHERE run.ingestion_run_id = mapping.ingestion_run_id AND run.state = 'published')
       WHERE locator.source_lineage = ?
         AND locator.locator = ?
         AND locator.variant_identity = ?
       ORDER BY locator.current DESC,
                locator.last_observed_revision_id DESC, mapping.mapped_at DESC LIMIT 1`,
    )
    .bind(sourceLineage, locator, variantKey ?? "")
    .first<ReconciledPrintingRow & { mapped_evidence_json: string | null }>();
  if (row?.mapped_evidence_json) {
    const evidence = JSON.parse(row.mapped_evidence_json) as { compatibility: PrintingCompatibility };
    return { ...row, ...evidence.compatibility };
  }
  return row ?? null;
}

export async function printingsAtLocator(
  database: CatalogueStore,
  sourceLineage: string,
  locator: string,
): Promise<ReconciledPrintingRow[]> {
  const rows = await repositoryStatements(database)
    .prepare(
      `SELECT printing.*
       FROM reconciled_printing_locators AS locator
       JOIN reconciled_printings AS printing
         ON printing.id = locator.printing_id
       WHERE locator.source_lineage = ?
         AND locator.locator = ?
       ORDER BY locator.current DESC,
                locator.last_observed_revision_id DESC,
                locator.variant_identity LIMIT 9`,
    )
    .bind(sourceLineage, locator)
    .all<ReconciledPrintingRow>();
  return boundedPrintingMatches(rows.results);
}

export async function gundamPrintingLineages(
  database: CatalogueStore,
  printingId: string,
  history?: NativeSourceHistory,
): Promise<
  {
    printing_id: string;
    source_lineage: "gundam-en-asia" | "gundam-en-us";
    current: number;
  }[]
> {
  if (history) {
    const records = await history.forEntity("printing", printingId, "locator");
    return (["gundam-en-asia", "gundam-en-us"] as const).flatMap((source_lineage) => {
      const evidence = records.filter((record) => record.kind === "locator" && record.sourceLineage === source_lineage);
      return evidence.length
        ? [{ printing_id: printingId, source_lineage, current: Number(evidence.some((record) => record.current)) }]
        : [];
    });
  }
  const rows = await repositoryStatements(database)
    .prepare(
      `SELECT printing_id, source_lineage, MAX(current) AS current
       FROM reconciled_printing_locators
       WHERE printing_id = ? AND source_lineage IN ('gundam-en-asia', 'gundam-en-us')
       GROUP BY printing_id, source_lineage
       ORDER BY printing_id, source_lineage`,
    )
    .bind(printingId)
    .all<{
      printing_id: string;
      source_lineage: "gundam-en-asia" | "gundam-en-us";
      current: number;
    }>();
  return rows.results;
}

export async function gundamCardLineages(
  database: CatalogueStore,
  cardId: string,
  history?: NativeSourceHistory,
): Promise<
  {
    card_id: string;
    source_lineage: "gundam-en-asia" | "gundam-en-us";
    current: number;
  }[]
> {
  if (history) {
    const records = await history.forEntity("card", cardId);
    return (["gundam-en-asia", "gundam-en-us"] as const).flatMap((source_lineage) => {
      const evidence = records.filter((record) => record.sourceLineage === source_lineage);
      return evidence.length
        ? [{ card_id: cardId, source_lineage, current: Number(evidence.some((record) => record.current)) }]
        : [];
    });
  }
  const rows = await repositoryStatements(database)
    .prepare(
      `SELECT card_id, source_lineage, MAX(current) AS current
       FROM reconciled_card_observations
       WHERE card_id = ? AND source_lineage IN ('gundam-en-asia', 'gundam-en-us')
       GROUP BY card_id, source_lineage
       ORDER BY card_id, source_lineage`,
    )
    .bind(cardId)
    .all<{
      card_id: string;
      source_lineage: "gundam-en-asia" | "gundam-en-us";
      current: number;
    }>();
  return rows.results;
}

export async function gundamPrintingHasProductMembership(
  database: CatalogueStore,
  printingId: string,
  products: readonly string[],
  history?: NativeSourceHistory,
): Promise<boolean> {
  if (history) {
    for await (const record of history.entityRecords("printing", printingId))
      if (
        record.kind === "membership" &&
        record.relationshipKind === "product" &&
        products.includes(record.relationshipValue!)
      )
        return true;
    return false;
  }
  const row = await repositoryStatements(database)
    .prepare(`SELECT 1
    FROM reconciled_printing_memberships
    WHERE printing_id = ? AND relationship_kind = 'product'
      AND relationship_value IN (SELECT value FROM json_each(?)) LIMIT 1`)
    .bind(printingId, canonicalJson(products))
    .first();
  return row !== null;
}

export async function hasPrintingLocatorFromLineage(
  database: CatalogueStore,
  printingId: string,
  sourceLineage: string,
): Promise<boolean> {
  const row = await repositoryStatements(database)
    .prepare(
      `SELECT printing_id
       FROM reconciled_printing_locators
       WHERE printing_id = ? AND source_lineage = ? AND current = 1
       LIMIT 1`,
    )
    .bind(printingId, sourceLineage)
    .first<{ printing_id: string }>();
  return row !== null;
}

export async function canonicalCardConflict(
  database: CatalogueStore,
  cardId: string,
  proposed: Omit<CatalogueCard, "id">,
  sourceLineage: string,
  authority: { effectiveRulesText: boolean; confirmedPublisherNumber?: boolean } = {
    effectiveRulesText: false,
  },
  native?: { history: NativeSourceHistory; card: CatalogueCard | undefined },
): Promise<string | null> {
  const row = native
    ? native.card
      ? { document_json: "" }
      : null
    : await repositoryStatements(database)
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
  const current = native?.card ?? revisionDocumentData(row.document_json);
  const currentCanonical = {
    game: current.game,
    official_identity:
      authority.confirmedPublisherNumber &&
      canonicalJson(current.official_identity) === canonicalJson({ kind: "unknown", value: null })
        ? proposed.official_identity
        : current.official_identity,
    name: current.name,
    game_data: current.game_data,
    ...(authority.effectiveRulesText ? {} : { effective_rules_text: current.effective_rules_text }),
  };
  const proposedCanonical = {
    game: proposed.game,
    official_identity: proposed.official_identity,
    name: proposed.name,
    game_data: proposed.game_data,
    ...(authority.effectiveRulesText ? {} : { effective_rules_text: proposed.effective_rules_text }),
  };
  if (
    canonicalJson(normalizedFormatting(currentCanonical)) === canonicalJson(normalizedFormatting(proposedCanonical))
  ) {
    return null;
  }
  const authorities = native
    ? {
        results: (await native.history.forEntity("card", cardId))
          .filter((record) => record.current)
          .map((record) => ({ source_lineage: record.sourceLineage })),
      }
    : await repositoryStatements(database)
        .prepare(
          `SELECT DISTINCT source_lineage
       FROM reconciled_card_observations
       WHERE card_id = ? AND current = 1`,
        )
        .bind(cardId)
        .all<{ source_lineage: string }>();
  if (authorities.results.length === 0) return null;
  if (
    sourceLineage === "gundam-en-us" &&
    authorities.results.some(({ source_lineage }) => source_lineage === "gundam-en-asia")
  ) {
    return substantiveFactsConflict(currentCanonical, proposedCanonical)
      ? "The retained Card facts conflict across Gundam English source lineages; EN-ASIA precedence cannot erase a substantive EN-US disagreement."
      : null;
  }
  return authorities.results.length > 0 &&
    authorities.results.every((authority) => authority.source_lineage === sourceLineage)
    ? null
    : "The retained Card facts conflict across authoritative source lineages and no deterministic authority rule resolves them.";
}

type PrintingFacts = Omit<CataloguePrinting, "id" | "card_id">;

export async function canonicalPrintingConflict(
  database: CatalogueStore,
  printingId: string,
  proposed: PrintingFacts,
  sourceLineage: string,
  native?: { history: NativeSourceHistory; printing: CataloguePrinting | undefined },
): Promise<string | null> {
  const row = native
    ? native.printing
      ? { document_json: "" }
      : null
    : await repositoryStatements(database)
        .prepare(
          `SELECT printing.document_json
       FROM catalogue_state AS state
       JOIN revision_printings AS printing
         ON printing.catalogue_revision_id = state.current_revision_id
       WHERE state.singleton = 1 AND printing.printing_id = ?`,
        )
        .bind(printingId)
        .first<{ document_json: string }>();
  if (row === null) return null;
  const current = native?.printing ?? (revisionDocumentData(row.document_json) as CataloguePrinting);
  const currentCanonical: PrintingFacts = {
    rarity: current.rarity,
    printed_rules_text: current.printed_rules_text,
    game_data: current.game_data,
  };
  if (!substantiveFactsConflict(currentCanonical, proposed)) {
    return null;
  }
  const authorities = native
    ? {
        results: (await native.history.forEntity("printing", printingId, "locator"))
          .filter((record) => record.kind === "locator" && record.current)
          .map((record) => ({ source_lineage: record.sourceLineage })),
      }
    : await repositoryStatements(database)
        .prepare(
          `SELECT DISTINCT source_lineage
       FROM reconciled_printing_locators
       WHERE printing_id = ? AND current = 1`,
        )
        .bind(printingId)
        .all<{ source_lineage: string }>();
  if (authorities.results.length === 0) return null;
  if (
    (sourceLineage === "gundam-en-asia" || sourceLineage === "gundam-en-us") &&
    authorities.results.some(
      ({ source_lineage }) =>
        (source_lineage === "gundam-en-asia" || source_lineage === "gundam-en-us") && source_lineage !== sourceLineage,
    )
  ) {
    return substantiveFactsConflict(currentCanonical, proposed)
      ? "The retained Printing facts conflict across Gundam English source lineages; EN-ASIA precedence cannot erase a substantive EN-US disagreement."
      : null;
  }
  return authorities.results.every((authority) => authority.source_lineage === sourceLineage)
    ? null
    : "The retained canonical Printing facts conflict across authoritative source lineages and no deterministic authority rule resolves them.";
}

export function printingFactsFormattingEquivalent(left: PrintingFacts, right: PrintingFacts): boolean {
  return canonicalJson(normalizedFormatting(left)) === canonicalJson(normalizedFormatting(right));
}

function normalizedFormatting(value: unknown): unknown {
  if (typeof value === "string") {
    return value.trim().replace(/\s+/g, " ");
  }
  if (Array.isArray(value)) return value.map(normalizedFormatting);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, normalizedFormatting(nested)]));
  }
  return value;
}

function substantiveFactsConflict(authoritative: unknown, corroborating: unknown): boolean {
  if (authoritative === null || authoritative === undefined || corroborating === null || corroborating === undefined) {
    return false;
  }
  if (Array.isArray(authoritative) || Array.isArray(corroborating)) {
    return canonicalJson(normalizedFormatting(authoritative)) !== canonicalJson(normalizedFormatting(corroborating));
  }
  if (typeof authoritative === "object" && typeof corroborating === "object") {
    const left = authoritative as Record<string, unknown>;
    const right = corroborating as Record<string, unknown>;
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].some((field) =>
      substantiveFactsConflict(left[field], right[field]),
    );
  }
  return canonicalJson(normalizedFormatting(authoritative)) !== canonicalJson(normalizedFormatting(corroborating));
}

function revisionDocumentData(documentJson: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(documentJson);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("A published Catalogue document is invalid.");
  }
  const document = parsed as Record<string, unknown>;
  if (document.data !== null && typeof document.data === "object" && !Array.isArray(document.data)) {
    return document.data as Record<string, unknown>;
  }
  return document;
}

export type ReconciliationTerminalResultRow = { result_json: string };

export function terminalResultInsertion(
  database: CatalogueStore,
  runId: string,
  result: Record<string, unknown>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(
      `INSERT OR IGNORE INTO reconciliation_terminal_results (
         ingestion_run_id, result_json
       ) VALUES (?, ?)`,
    )
    .bind(runId, canonicalJson(result));
}

export function terminalResultStatement(database: CatalogueStore, runId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(
      `SELECT result_json
       FROM reconciliation_terminal_results
       WHERE ingestion_run_id = ?`,
    )
    .bind(runId);
}

export async function crossSourcePrintingCandidates(
  database: CatalogueStore,
  compatibility: PrintingCompatibility,
): Promise<ReconciledPrintingRow[]> {
  return boundedPrintingMatches(
    (
      await repositoryStatements(database)
        .prepare(`SELECT * FROM reconciled_printings
    WHERE card_id = ? AND source_lineage <> ? AND printed_fields_digest = ?
      AND rarity_normalized IS ? AND treatment IS ? ORDER BY id LIMIT 9`)
        .bind(
          compatibility.card_id,
          compatibility.source_lineage,
          compatibility.printed_fields_digest,
          compatibility.rarity_normalized,
          compatibility.treatment,
        )
        .all<ReconciledPrintingRow>()
    ).results,
  );
}

function boundedPrintingMatches(rows: ReconciledPrintingRow[]): ReconciledPrintingRow[] {
  if (rows.length > 8 || new TextEncoder().encode(canonicalJson(rows)).byteLength > 512000)
    throw new Error("reconciliation_capacity_exceeded: one Printing identity match exceeds its candidate budget.");
  return rows;
}

export async function* gundamAffectedPrintingIds(
  database: CatalogueStore,
  checkedLineages: readonly string[],
  after = "",
) {
  for (;;) {
    const rows = (
      await repositoryStatements(database)
        .prepare(`SELECT DISTINCT printing_id
      FROM reconciled_printing_locators
      WHERE printing_id > ? AND current = 1 AND source_lineage IN ('gundam-en-asia', 'gundam-en-us')
        AND source_lineage IN (SELECT value FROM json_each(?))
      ORDER BY printing_id LIMIT 100`)
        .bind(after, canonicalJson(checkedLineages))
        .all<{ printing_id: string }>()
    ).results;
    for (const row of rows) {
      yield row.printing_id;
      after = row.printing_id;
    }
    if (rows.length < 100) return;
  }
}
