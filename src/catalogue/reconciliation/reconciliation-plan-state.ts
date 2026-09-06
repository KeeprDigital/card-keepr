import { restorePartitionedRecord } from "./reconciliation-text";
import {
  observedPlanStatement,
  previouslyObservedEntitiesStatement,
  nextPlanMembershipGroupStatement,
  nextMembershipPlanStatement,
} from "./reconciliation-plan-repository";
import { type CatalogueStore, type SupportedGame, sha256Text, canonicalJson } from "../shared";
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
  async append(plan: ObservationPlan) {
    await this.index.seed(plan.sourceObservationId, { id: plan.sourceObservationId, plan });
  }
  async get(observationId: string) {
    return (await this.index.get(observationId))?.plan;
  }
  async *[Symbol.asyncIterator]() {
    for await (const value of this.index.entityValues()) yield value.plan;
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
  async *disappearanceWarnings(kind: "card" | "printing", lineage: string): AsyncGenerator<Record<string, unknown>> {
    let after = "";
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
        if (!(await this.hasObserved(kind, id, lineage)))
          yield {
            code: "record_not_observed",
            [kind === "card" ? "card_id" : "printing_id"]: id,
            detail: `The ${kind === "card" ? "Card" : "Printing"} was not observed in this complete run; it remains historical and is not withdrawn.`,
          };
        after = id;
      }
    }
  }
  async *memberships(): AsyncGenerator<{ printingId: string; sourceLineage: string; memberships: Memberships }> {
    let printingId = "",
      sourceLineage = "";
    for (;;) {
      let group: { printing_id: string; source_lineage: string } | null;
      try {
        group = await nextPlanMembershipGroupStatement(
          this.database,
          this.runId,
          this.index.position,
          printingId,
          sourceLineage,
        ).first<{ printing_id: string; source_lineage: string }>();
      } catch (cause) {
        throw new ReconciliationReducerStorageError(cause);
      }
      if (!group) return;
      printingId = group.printing_id;
      sourceLineage = group.source_lineage;
      const products = new Set<string>(),
        contexts = new Set<string>(),
        buckets = new Set<string>();
      let after = "",
        count = 0,
        bytes = 0;
      for (;;) {
        let row: { content: string; sha256: string; key_digest: string } | null;
        try {
          row = await nextMembershipPlanStatement(
            this.database,
            this.runId,
            this.index.position,
            printingId,
            sourceLineage,
            after,
          ).first<{ content: string; sha256: string; key_digest: string }>();
        } catch (cause) {
          throw new ReconciliationReducerStorageError(cause);
        }
        if (!row) break;
        if ((await sha256Text(row.content)) !== row.sha256)
          throw new Error("Observation plan failed integrity verification.");
        const { plan } = (await restorePartitionedRecord(this.database, this.runId, JSON.parse(row.content))) as {
          plan: ObservationPlan;
        };
        bytes += new TextEncoder().encode(canonicalJson(plan.memberships)).byteLength;
        if (++count > 500 || bytes > 1048576)
          throw new Error("reconciliation_capacity_exceeded: one Printing lineage has too much membership evidence.");
        for (const value of plan.memberships.products) products.add(value);
        for (const value of plan.memberships.distribution_contexts) contexts.add(value);
        for (const value of plan.memberships.source_buckets) buckets.add(value);
        after = row.key_digest;
      }
      yield {
        printingId,
        sourceLineage,
        memberships: {
          products: [...products].sort(),
          distribution_contexts: [...contexts].sort(),
          source_buckets: [...buckets].sort(),
        },
      };
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
