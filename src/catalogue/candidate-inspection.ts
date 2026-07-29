import type { FixtureCandidate } from "./fixture";
import { canonicalJson } from "./serialization";

export async function inspectCatalogueCandidate(
  database: D1Database,
  input: {
    runId: string;
    expectedRevisionId: string;
    candidate: FixtureCandidate;
    fallbackWarnings: readonly Record<string, unknown>[];
  },
) {
  const [
    warnings,
    priorCards,
    priorPrintings,
    plans,
    printingLineages,
    cardLineages,
  ] = await Promise.all([
    candidateWarnings(database, input.runId, input.fallbackWarnings),
    database
      .prepare(
        `SELECT card_id AS id, document_json
         FROM revision_cards
         WHERE catalogue_revision_id = ?`,
      )
      .bind(input.expectedRevisionId)
      .all<{ id: string; document_json: string }>(),
    database
      .prepare(
        `SELECT printing_id AS id, document_json
         FROM revision_printings
         WHERE catalogue_revision_id = ?`,
      )
      .bind(input.expectedRevisionId)
      .all<{ id: string; document_json: string }>(),
    database
      .prepare(
        `SELECT card_id, printing_id, source_lineage
         FROM reconciliation_candidates
         WHERE ingestion_run_id = ?`,
      )
      .bind(input.runId)
      .all<{
        card_id: string;
        printing_id: string | null;
        source_lineage: string;
      }>(),
    database
      .prepare(
        `SELECT printing_id, source_lineage
         FROM reconciled_printing_locators`,
      )
      .all<{ printing_id: string; source_lineage: string }>(),
    database
      .prepare(
        `SELECT card_id, source_lineage
         FROM reconciled_card_observations
         WHERE current = 1`,
      )
      .all<{ card_id: string; source_lineage: string }>(),
  ]);
  const cardsBefore = documentMap(priorCards.results);
  const printingsBefore = documentMap(priorPrintings.results);
  const observedCardIds = new Set(
    plans.results.map((plan) => plan.card_id),
  );
  const observedPrintingIds = new Set(
    plans.results.flatMap((plan) =>
      plan.printing_id === null ? [] : [plan.printing_id],
    ),
  );
  const selectedLineages = new Set(
    plans.results.map((plan) => plan.source_lineage),
  );
  const printingEvidence = groupedLineages(
    printingLineages.results,
    "printing_id",
  );
  const cardEvidence = groupedLineages(cardLineages.results, "card_id");
  const cards = {
    added: input.candidate.cards
      .filter((card) => !cardsBefore.has(card.id))
      .map((card) => card.id),
    changed: input.candidate.cards
      .filter((card) => changed(cardsBefore, card))
      .map((card) => card.id),
    missing_observations: input.candidate.cards
      .filter(
        (card) =>
          cardsBefore.has(card.id) &&
          intersects(
            cardEvidence.get(card.id) ?? new Set(),
            selectedLineages,
          ) &&
          !observedCardIds.has(card.id),
      )
      .map((card) => card.id),
  };
  const printings = {
    added: input.candidate.printings
      .filter((printing) => !printingsBefore.has(printing.id))
      .map((printing) => printing.id),
    changed: input.candidate.printings
      .filter((printing) => changed(printingsBefore, printing))
      .map((printing) => printing.id),
    identity_matches: [...observedPrintingIds]
      .filter((id) => printingsBefore.has(id))
      .sort(),
    missing_observations: input.candidate.printings
      .filter((printing) => {
          return (
            printingsBefore.has(printing.id) &&
            intersects(
              printingEvidence.get(printing.id) ?? new Set(),
              selectedLineages,
            ) &&
            !observedPrintingIds.has(printing.id)
        );
      })
      .map((printing) => printing.id),
  };
  return {
    summary: {
      cards_added: cards.added.length,
      printings_added: printings.added.length,
      warnings: warnings.length,
    },
    cards,
    printings,
    warnings,
  };
}

function groupedLineages<T extends "printing_id" | "card_id">(
  rows: readonly (Record<T, string> & { source_lineage: string })[],
  idField: T,
): Map<string, Set<string>> {
  const grouped = new Map<string, Set<string>>();
  for (const row of rows) {
    const id = row[idField];
    const lineages = grouped.get(id) ?? new Set<string>();
    lineages.add(row.source_lineage);
    grouped.set(id, lineages);
  }
  return grouped;
}

function intersects(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  return [...left].some((value) => right.has(value));
}

async function candidateWarnings(
  database: D1Database,
  runId: string,
  fallback: readonly Record<string, unknown>[],
) {
  const reconciled = await database
    .prepare(
      `SELECT warnings_json
       FROM reconciliation_candidates
       WHERE ingestion_run_id = ?
       ORDER BY source_observation_id
       LIMIT 1`,
    )
    .bind(runId)
    .first<{ warnings_json: string }>();
  if (reconciled === null) return fallback;
  const parsed: unknown = JSON.parse(reconciled.warnings_json);
  return Array.isArray(parsed) ? parsed.filter(isRecord) : fallback;
}

function documentMap(
  entries: readonly { id: string; document_json: string }[],
): Map<string, Record<string, unknown>> {
  return new Map(
    entries.map((entry) => [
      entry.id,
      JSON.parse(entry.document_json) as Record<string, unknown>,
    ]),
  );
}

function changed(
  prior: ReadonlyMap<string, Record<string, unknown>>,
  candidate: Record<string, unknown>,
): boolean {
  const document = prior.get(String(candidate.id));
  return (
    document !== undefined &&
    Object.entries(candidate).some(
      ([key, value]) =>
        canonicalJson(document[key]) !== canonicalJson(value),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
