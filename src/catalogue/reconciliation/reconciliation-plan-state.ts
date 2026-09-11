import { membershipPlanStatement, observedPlanStatement, previouslyObservedEntitiesStatement } from "./reconciliation-plan-repository";
import { type CatalogueStore, type SupportedGame, sha256Text } from "../shared";
import type { Memberships, PrintingCompatibility, ProvenancedWithdrawal } from "./reconciliation-model";
import { ReconciliationReducerIndex, ReconciliationReducerStorageError } from "./reconciliation-reducer-state";

export type ObservationPlan = {
  sourceObservationSetId: string;
  sourceSnapshotId: string;
  sourceObservationId: string;
  sourceLineage: string;
  supportedGame: SupportedGame;
  observationKind: "card_printing" | "official_erratum";
  cardId: string;
  printingId: string | null;
  locator: string | null;
  variantKey: string | null;
  compatibility: PrintingCompatibility | null;
  memberships: Memberships;
  withdrawal: ProvenancedWithdrawal | null;
  sourceCardFactsJson: string | null;
};

/** Observation identity is the stable ordering key for retained plans and their digest. */
export class ReconciliationPlanState implements AsyncIterable<ObservationPlan> {
  private index: ReconciliationReducerIndex<{ id: string; plan: ObservationPlan }>;
  constructor(
    private database: CatalogueStore,
    private runId: string,
  ) {
    this.index = new ReconciliationReducerIndex(database, runId, "observation_plans", (value) => value.plan.cardId);
  }
  get position() {
    return this.index.position;
  }
  resumeAt(position: number) {
    this.index.resumeAt(position);
  }
  async append(plan: ObservationPlan) {
    await this.index.seed(plan.sourceObservationId, { id: plan.sourceObservationId, plan });
  }
  async get(observationId: string) {
    return (await this.index.get(observationId))?.plan;
  }
  async *canonicalEntries(after: string) {
    for await (const value of this.values(after)) yield { key: value.sourceObservationId, value };
  }
  [Symbol.asyncIterator]() {
    return this.values();
  }
  async *values(after = "") {
    for await (const value of this.index.entityValues(after)) yield value.plan;
  }
  async hasMemberships(game: SupportedGame): Promise<boolean> {
    let row: { content: string; sha256: string } | null;
    try {
      row = await membershipPlanStatement(this.database, this.runId, this.index.position, game).first<{
        content: string;
        sha256: string;
      }>();
    } catch (cause) {
      throw new ReconciliationReducerStorageError(cause);
    }
    if (!row) return false;
    if ((await sha256Text(row.content)) !== row.sha256)
      throw new Error("Observation plan failed integrity verification.");
    return true;
  }
  async hasObserved(kind: "card" | "printing", entityId: string, lineage?: string): Promise<boolean> {
    let row: { content: string; sha256: string } | null;
    try {
      row = await observedPlanStatement(this.database, this.runId, this.index.position, kind, entityId, lineage).first<{
        content: string;
        sha256: string;
      }>();
    } catch (cause) {
      throw new ReconciliationReducerStorageError(cause);
    }
    if (!row) return false;
    if ((await sha256Text(row.content)) !== row.sha256)
      throw new Error("Observation plan failed integrity verification.");
    return true;
  }
  async *previousObservationEntries(kind: "card" | "printing", lineage: string, after = "") {
    for (;;) {
      let rows: { id: string }[];
      try {
        rows = (await previouslyObservedEntitiesStatement(this.database, kind, lineage, after).all<{ id: string }>())
          .results;
      } catch (cause) {
        throw new ReconciliationReducerStorageError(cause);
      }
      if (!rows.length) return;
      for (const { id } of rows) {
        const warning = !(await this.hasObserved(kind, id, lineage))
          ? {
              code: "record_not_observed",
              [kind === "card" ? "card_id" : "printing_id"]: id,
              detail: `The ${kind === "card" ? "Card" : "Printing"} was not observed in this complete run; it remains historical and is not withdrawn.`,
            }
          : null;
        yield { id, warning };
        after = id;
      }
    }
  }
  async forCard(cardId: string) {
    this.index.beginObservation();
    const result: Pick<ObservationPlan, "sourceObservationId" | "locator" | "printingId">[] = [];
    for await (const { plan } of this.index.matchingBeforeObservation(cardId))
      result.push({
        sourceObservationId: plan.sourceObservationId,
        locator: plan.locator,
        printingId: plan.printingId,
      });
    return result.sort((a, b) => a.sourceObservationId.localeCompare(b.sourceObservationId));
  }
}
