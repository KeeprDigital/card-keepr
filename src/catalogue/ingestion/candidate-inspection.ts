import { type CatalogueCandidate, type CatalogueStore, canonicalJson } from "../shared";
import {
  type CandidateObservedEntityRow,
  type ReconciliationPartitionLineageRow,
  candidateObservedEntitiesStatement,
  candidateWarningDocumentStatement,
  currentCardObservationLineagesStatement,
  currentPrintingLocatorsStatement,
  reconciliationPartitionLineagesStatement,
  revisionCardDocumentsStatement,
  revisionLegalityDocumentsStatement,
  revisionPrintingDocumentsStatement,
} from "./candidate-inspection-repository";

export async function inspectCatalogueCandidate(
  database: CatalogueStore,
  input: {
    runId: string;
    expectedRevisionId: string;
    candidate: CatalogueCandidate;
    fallbackWarnings: readonly Record<string, unknown>[];
  },
) {
  const [
    warnings,
    priorCards,
    priorPrintings,
    priorLegalityRules,
    plans,
    evidenceLineages,
    printingLineages,
    cardLineages,
  ] = await Promise.all([
    candidateWarnings(database, input.runId, input.fallbackWarnings),
    revisionCardDocumentsStatement(database, input.expectedRevisionId).all<{ id: string; document_json: string }>(),
    revisionPrintingDocumentsStatement(database, input.expectedRevisionId).all<{ id: string; document_json: string }>(),
    revisionLegalityDocumentsStatement(database, input.expectedRevisionId).all<{ id: string; document_json: string }>(),
    candidateObservedEntitiesStatement(database, input.runId).all<CandidateObservedEntityRow>(),
    reconciliationPartitionLineagesStatement(database, input.runId).all<ReconciliationPartitionLineageRow>(),
    currentPrintingLocatorsStatement(database).all<{ printing_id: string; source_lineage: string }>(),
    currentCardObservationLineagesStatement(database).all<{ card_id: string; source_lineage: string }>(),
  ]);
  const cardsBefore = documentMap(priorCards.results);
  const printingsBefore = documentMap(priorPrintings.results);
  const legalityRulesBefore = documentMap(priorLegalityRules.results);
  const observedCardIds = new Set(plans.results.map((plan) => plan.card_id));
  const observedPrintingIds = new Set(
    plans.results.flatMap((plan) => (plan.printing_id === null ? [] : [plan.printing_id])),
  );
  const selectedLineages = new Set(evidenceLineages.results.map(({ source_lineage }) => source_lineage));
  const printingEvidence = groupedLineages(printingLineages.results, "printing_id");
  const cardEvidence = groupedLineages(cardLineages.results, "card_id");
  const cards = {
    added: input.candidate.cards.filter((card) => !cardsBefore.has(card.id)).map((card) => card.id),
    changed: input.candidate.cards.filter((card) => changed(cardsBefore, card)).map((card) => card.id),
    missing_observations: input.candidate.cards
      .filter(
        (card) =>
          cardsBefore.has(card.id) &&
          intersects(cardEvidence.get(card.id) ?? new Set(), selectedLineages) &&
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
    identity_matches: [...observedPrintingIds].filter((id) => printingsBefore.has(id)).sort(),
    missing_observations: input.candidate.printings
      .filter((printing) => {
        return (
          printingsBefore.has(printing.id) &&
          intersects(printingEvidence.get(printing.id) ?? new Set(), selectedLineages) &&
          !observedPrintingIds.has(printing.id)
        );
      })
      .map((printing) => printing.id),
  };
  const candidateLegalityRules = input.candidate.legality_rules ?? [];
  const legalityRules = {
    added: candidateLegalityRules
      .filter((rule) => !legalityRulesBefore.has(rule.id))
      .map((rule) => rule.id)
      .sort(),
    changed: candidateLegalityRules
      .filter((rule) => changedLegalityRule(legalityRulesBefore, rule))
      .map((rule) => rule.id)
      .sort(),
    lifecycle: {
      current: candidateLegalityRules
        .filter((rule) => rule.current !== false)
        .map((rule) => rule.id)
        .sort(),
      non_current: candidateLegalityRules
        .filter((rule) => rule.current === false)
        .map((rule) => rule.id)
        .sort(),
    },
  };
  return {
    summary: {
      cards_added: cards.added.length,
      printings_added: printings.added.length,
      legality_rules_added: legalityRules.added.length,
      legality_rules_changed: legalityRules.changed.length,
      legality_rules_current: legalityRules.lifecycle.current.length,
      legality_rules_non_current: legalityRules.lifecycle.non_current.length,
      warnings: warnings.length,
    },
    cards,
    printings,
    legality_rules: legalityRules,
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

function intersects(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return [...left].some((value) => right.has(value));
}

async function candidateWarnings(
  database: CatalogueStore,
  runId: string,
  fallback: readonly Record<string, unknown>[],
) {
  const reconciled = await candidateWarningDocumentStatement(database, runId).first<{ warnings_json: string }>();
  if (reconciled === null) return fallback;
  const parsed: unknown = JSON.parse(reconciled.warnings_json);
  return Array.isArray(parsed) ? parsed.filter(isRecord) : fallback;
}

function documentMap(entries: readonly { id: string; document_json: string }[]): Map<string, Record<string, unknown>> {
  return new Map(entries.map((entry) => [entry.id, revisionDocumentData(entry.document_json)]));
}

function revisionDocumentData(documentJson: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(documentJson);
  if (!isRecord(parsed)) {
    throw new Error("A prior Catalogue document is invalid.");
  }
  return isRecord(parsed.data) ? parsed.data : parsed;
}

function changed(prior: ReadonlyMap<string, Record<string, unknown>>, candidate: Record<string, unknown>): boolean {
  const document = prior.get(String(candidate.id));
  return (
    document !== undefined &&
    Object.entries(candidate).some(
      ([key, value]) => key !== "curated_provenance" && canonicalJson(document[key]) !== canonicalJson(value),
    )
  );
}

function changedLegalityRule(
  prior: ReadonlyMap<string, Record<string, unknown>>,
  candidate: Record<string, unknown>,
): boolean {
  const document = prior.get(String(candidate.id));
  return (
    document !== undefined &&
    canonicalJson(legalityInspectionDocument(document)) !== canonicalJson(legalityInspectionDocument(candidate))
  );
}

function legalityInspectionDocument(rule: Record<string, unknown>): Record<string, unknown> {
  const {
    source_lineage: _sourceLineage,
    source_snapshot_id: _sourceSnapshotId,
    source_observation_set_id: _sourceObservationSetId,
    source_observation_id: _sourceObservationId,
    source_observation_pointer: _sourceObservationPointer,
    source_field_pointers: _sourceFieldPointers,
    first_revision_id: _firstRevisionId,
    last_observed_revision_id: _lastObservedRevisionId,
    last_missing_revision_id: _lastMissingRevisionId,
    ...inspectable
  } = rule;
  return {
    ...inspectable,
    current: rule.current !== false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
