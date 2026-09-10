import { type CatalogueStore, canonicalJson } from "../shared";
import { reconciliationCheckpoint } from "./reconciliation-checkpoint";
import type { ReconciledPrintingRow } from "./reconciliation-repository";
import type { LocatorEvidence } from "./reconciliation-publication";
import type { RelationshipEvidenceRow } from "./reconciliation-relationships";
import type { SourceHistoryCursor } from "./native-source-history";
import { NativeSourceHistory, type HistoryPublication } from "./native-source-history-state";
import {
  currentNativePrintingStatement,
  historyPublicationBindingsStatement,
} from "./native-source-history-repository";

type PrintingHistoryRow = {
  candidate_id: string;
  preparation_id: string;
  card_id: string;
  first_revision_id: string;
  last_observed_revision_id: string;
  withdrawn: number;
  withdrawal_revision_id: string | null;
  withdrawal_evidence_json: string | null;
};
/** Administration reads the accepted evidence head; consumer composition reuse cannot erase later observations. */
export async function nativePrintingHistory(db: CatalogueStore, printingId: string) {
  const rows = await currentNativePrintingStatement(db, printingId).all<PrintingHistoryRow>();
  if (rows.results.length === 0) return null;
  if (rows.results.length !== 1)
    throw new Error("Native Printing administration found conflicting accepted identities.");
  const row = rows.results[0]!;
  const checkpoint = await reconciliationCheckpoint<{ sourceHistory?: SourceHistoryCursor }>(
    db,
    row.preparation_id,
    "disappearance_warnings",
  );
  const cursor = checkpoint?.value.sourceHistory;
  if (cursor?.version !== 1 || cursor.stage !== "complete" || cursor.current !== row.candidate_id)
    throw new Error("Native Printing administration requires complete retained source history.");
  const records = await new NativeSourceHistory(db, row.preparation_id, cursor.history).forEntity(
    "printing",
    printingId,
  );
  if (!records.some((record) => record.kind === "locator"))
    throw new Error("Native Printing administration lost its retained locator history.");
  const candidates = new Set<string>(),
    revisions = new Set<string>();
  for (const record of records)
    for (const reference of [record.first, record.last, record.missing]) {
      if (reference === null) continue;
      if ("candidate" in reference) candidates.add(reference.candidate);
      else revisions.add(reference.revision);
    }
  const bindings = await historyPublicationBindingsStatement(
    db,
    canonicalJson([...candidates]),
    canonicalJson([...revisions]),
  ).all<{ candidate_id: string | null; id: string; published_at: string }>();
  const published = new Map<string, { id: string; order: string }>();
  for (const binding of bindings.results) {
    if (binding.candidate_id !== null)
      published.set(`candidate:${binding.candidate_id}`, { id: binding.id, order: binding.published_at });
    published.set(`revision:${binding.id}`, { id: binding.id, order: binding.published_at });
  }
  const resolve = (reference: HistoryPublication) => {
    const key = "candidate" in reference ? `candidate:${reference.candidate}` : `revision:${reference.revision}`;
    const result = published.get(key);
    if (!result) throw new Error("Native source history lacks its exact publication binding.");
    return result;
  };
  const locators: (Omit<LocatorEvidence, "current"> & { current: number })[] = [];
  const memberships: RelationshipEvidenceRow[] = [];
  for (const record of records) {
    const first = resolve(record.first),
      last = resolve(record.last);
    const common = {
      source_lineage: record.sourceLineage,
      first_revision_id: first.id,
      last_observed_revision_id: last.id,
      current: Number(record.current),
      last_missing_revision_id: record.missing === null ? null : resolve(record.missing).id,
    };
    if (record.kind === "locator")
      locators.push({ ...common, locator: record.locator!, variant_key: record.variantKey ?? null });
    else if (record.kind === "membership")
      memberships.push({
        ...common,
        relationship_kind: record.relationshipKind!,
        relationship_value: record.relationshipValue!,
        source_observation_id: record.sourceObservationId!,
        first_revision_order: first.order,
        last_observed_revision_order: last.order,
      });
  }
  locators.sort((a, b) =>
    canonicalJson([a.source_lineage, a.locator, a.variant_key]).localeCompare(
      canonicalJson([b.source_lineage, b.locator, b.variant_key]),
    ),
  );
  return {
    printing: { ...row, id: printingId } as Pick<
      ReconciledPrintingRow,
      | "id"
      | "card_id"
      | "first_revision_id"
      | "last_observed_revision_id"
      | "withdrawn"
      | "withdrawal_revision_id"
      | "withdrawal_evidence_json"
    >,
    locators,
    memberships,
  };
}
