import { type CatalogueCard, type CataloguePrinting, type CatalogueStore, canonicalJson, sha256Text } from "../shared";
import type { ReconciliationCardState } from "./reconciliation-card-state";
import type { ReconciliationPlanState } from "./reconciliation-plan-state";
import { ReconciliationReducerIndex } from "./reconciliation-reducer-state";
import type { ReconciliationRecordCollection } from "./reconciliation-record-collection";
import { reconciliationCheckpoint, retainReconciliationCheckpoint } from "./reconciliation-checkpoint";
import { ReconciliationContinuation } from "./reconciliation-continuation";

export type CheckedCardScope = {
  sourceLineage: string;
  supportedGame: string;
  cardIdentities: readonly { kind: string; value: string }[];
};

type Cursor = {
  stage: "printings" | "cards" | "complete";
  after: string;
  cards: number;
  warnings: { position: number; count: number };
};

/** Named scopes compare manifest-verified native predecessors without treating outside-scope inventory as checked. */
export async function prepareScopedDisappearanceWarnings(
  database: CatalogueStore,
  runId: string,
  scopes: readonly CheckedCardScope[],
  priorCards: ReconciliationCardState,
  priorPrintings: ReconciliationReducerIndex<CataloguePrinting>,
  plans: ReconciliationPlanState,
  warnings: ReconciliationRecordCollection<Record<string, unknown>>,
  yieldAtCheckpoint: boolean,
) {
  if (scopes.length === 0) return;
  const retained = await reconciliationCheckpoint<Cursor>(database, runId, "scoped_disappearance");
  const cards = new ReconciliationReducerIndex<{ id: string; lineage: string }>(database, runId, "scoped_prior_cards");
  const cursor: Cursor = retained?.value ?? { stage: "printings", after: "", cards: 0, warnings: warnings.cursor };
  let ordinal = (retained?.ordinal ?? -1) + 1;
  if (retained) {
    cards.resumeAt(cursor.cards);
    warnings.resumeAt(cursor.warnings);
  }
  const save = async () => {
    cursor.cards = cards.position;
    cursor.warnings = warnings.cursor;
    await retainReconciliationCheckpoint(database, runId, "scoped_disappearance", ordinal, cursor);
    if (yieldAtCheckpoint) throw new ReconciliationContinuation({ phase: "scoped_disappearance", ordinal });
    ordinal++;
  };
  const warn = async (kind: "card" | "printing", id: string, lineage: string) => {
    if (!(await plans.hasObserved(kind, id, lineage)))
      await warnings.push({
        code: "record_not_observed",
        [`${kind}_id`]: id,
        source_lineage: lineage,
        detail: `The ${kind === "card" ? "Card" : "Printing"} was not observed within the declared Card scope; it remains historical and is not withdrawn.`,
      });
  };
  if (cursor.stage === "printings") {
    for await (const printing of priorPrintings.entityValues(cursor.after)) {
      const card = await priorCards.get(printing.card_id);
      for (const lineage of checkedPrintingLineages(card, printing, scopes)) {
        await cards.seed(await sha256Text(canonicalJson([printing.card_id, lineage])), {
          id: printing.card_id,
          lineage,
        });
        await warn("printing", printing.id, lineage);
      }
      cursor.after = printing.id;
      await save();
    }
    cursor.stage = "cards";
    cursor.after = "";
    await save();
  }
  if (cursor.stage === "cards") {
    for await (const entry of cards.latestEntries(cursor.after)) {
      await warn("card", entry.value.id, entry.value.lineage);
      cursor.after = entry.key;
      await save();
    }
    cursor.stage = "complete";
    await save();
  }
}

export function checkedPrintingLineages(
  card: CatalogueCard | undefined,
  printing: CataloguePrinting,
  scopes: readonly CheckedCardScope[],
) {
  if (!card) return [];
  return [
    ...new Set(
      scopes
        .filter(
          (scope) =>
            scope.supportedGame === card.game &&
            scope.cardIdentities.some(
              (identity) =>
                identity.kind === card.official_identity.kind && identity.value === card.official_identity.value,
            ) &&
            printing.locator_evidence?.some((evidence) => evidence.source_lineage === scope.sourceLineage),
        )
        .map((scope) => scope.sourceLineage),
    ),
  ].sort();
}
