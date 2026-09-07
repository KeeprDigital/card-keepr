import { type CatalogueStore, canonicalJson, sha256Text } from "../shared";
import type { ReconciliationCandidateState } from "./reconciliation-candidate-state";
import type { ReconciliationPlanState } from "./reconciliation-plan-state";
import { ReconciliationReducerIndex } from "./reconciliation-reducer-state";
import { documentStorage } from "./reconciliation-document";
import { canonicalValueDigest } from "./reconciliation-preparation";
import {
  currentPrintingMembershipsStatement,
  currentWithdrawalEvidenceStatement,
} from "./reconciliation-read-repository";
import { reconciliationCheckpoint, retainReconciliationCheckpoint } from "./reconciliation-checkpoint";
import { ReconciliationContinuation } from "./reconciliation-continuation";

type Value = { id: string; value: Record<string, unknown> };
type Membership = {
  printing_id: string;
  source_lineage: string;
  relationship_kind: string;
  relationship_value: string;
};
type Stage = "memberships" | "card_withdrawals" | "printing_withdrawals" | "plans" | "complete";
type Cursor = {
  inputDigest: string;
  stage: Stage;
  afterMembership: string[];
  after: string;
  membership: number;
  target: number;
  processedPlans: number;
  memberships: number;
  withdrawals: number;
};

/** Prepare the semantic projection separately from its canonical ordering and digest. */
export async function prepareSemanticState(
  database: CatalogueStore,
  runId: string,
  draft: ReconciliationCandidateState,
  plans: ReconciliationPlanState,
  checkedSourceLineages: readonly string[],
  yieldAtCheckpoint: boolean,
) {
  const memberships = new ReconciliationReducerIndex<Value>(database, runId, "semantic_membership_values");
  const withdrawals = new ReconciliationReducerIndex<Value>(database, runId, "semantic_withdrawal_values");
  const inputDigest = await canonicalValueDigest({
    checkedSourceLineages,
    draft: draft.positions,
    plans: plans.position,
  });
  const checkpoint = await reconciliationCheckpoint<Cursor>(database, runId, "semantic_preparation");
  const cursor: Cursor = checkpoint?.value ?? {
    inputDigest,
    stage: "memberships",
    afterMembership: ["", "", "", ""],
    after: "",
    membership: 0,
    target: 0,
    processedPlans: 0,
    memberships: 0,
    withdrawals: 0,
  };
  if (cursor.inputDigest !== inputDigest) throw new Error("Semantic preparation provenance changed.");
  memberships.resumeAt(cursor.memberships);
  withdrawals.resumeAt(cursor.withdrawals);
  let ordinal = (checkpoint?.ordinal ?? -1) + 1;
  let work = 0,
    bytes = 0;
  const save = async () => {
    cursor.memberships = memberships.position;
    cursor.withdrawals = withdrawals.position;
    await retainReconciliationCheckpoint(database, runId, "semantic_preparation", ordinal, cursor);
    if (yieldAtCheckpoint) throw new ReconciliationContinuation({ phase: "semantic_preparation", ordinal });
    ordinal++;
    work = 0;
    bytes = 0;
  };
  const before = async (value: unknown) => {
    const size = new TextEncoder().encode(canonicalJson(value)).byteLength;
    if (work && bytes + size > 512000) await save();
    bytes += size;
  };
  const tick = async () => {
    if (++work >= 4 || bytes >= 512000) await save();
  };
  const advance = async (stage: Stage) => {
    cursor.stage = stage;
    cursor.after = "";
    await save();
  };
  const addMembership = async (value: Record<string, unknown>) => {
    const id = await sha256Text(canonicalJson(value));
    await memberships.seed(id, { id, value });
  };
  const observedLineages = new Set(checkedSourceLineages);
  if (cursor.stage === "memberships") {
    for (;;) {
      const page = await documentStorage(() =>
        currentPrintingMembershipsStatement(database, cursor.afterMembership).all<Membership>(),
      );
      if (!page.results.length) break;
      for (const row of page.results) {
        await before(row);
        if (
          !observedLineages.has(row.source_lineage) &&
          row.relationship_kind !== "source_bucket" &&
          (await draft.has("printings", row.printing_id))
        )
          await addMembership(row);
        cursor.afterMembership = [row.printing_id, row.source_lineage, row.relationship_kind, row.relationship_value];
        await tick();
      }
    }
    await advance("card_withdrawals");
  }
  for (const entityType of ["card", "printing"] as const) {
    if (cursor.stage !== `${entityType}_withdrawals`) continue;
    for (;;) {
      const row = await documentStorage(() =>
        currentWithdrawalEvidenceStatement(database, entityType, cursor.after).first<{
          id: string;
          withdrawal_evidence_json: string;
        }>(),
      );
      if (!row) break;
      await before(row);
      if (await draft.has(entityType === "card" ? "cards" : "printings", row.id)) {
        const evidence = JSON.parse(row.withdrawal_evidence_json) as Record<string, unknown>;
        const id = `${entityType}:${row.id}`;
        await withdrawals.seed(id, {
          id,
          value: {
            entity_type: entityType,
            entity_id: row.id,
            assertion: evidence.assertion,
            state: evidence.state,
            effective_at: evidence.effective_at,
          },
        });
      }
      cursor.after = row.id;
      await tick();
    }
    await advance(entityType === "card" ? "printing_withdrawals" : "plans");
  }
  if (cursor.stage === "plans") {
    for await (const plan of plans.values(cursor.after)) {
      await before(plan);
      if (plan.printingId !== null) {
        const products = plan.memberships.products;
        const contexts = plan.memberships.distribution_contexts;
        while (cursor.membership < products.length + contexts.length) {
          const product = cursor.membership < products.length;
          const value = product ? products[cursor.membership]! : contexts[cursor.membership - products.length]!;
          await addMembership({
            printing_id: plan.printingId,
            source_lineage: plan.sourceLineage,
            relationship_kind: product ? "product" : "distribution_context",
            relationship_value: value,
          });
          cursor.membership++;
          await tick();
        }
      }
      if (plan.withdrawal !== null) {
        const targets = [
          ...(plan.withdrawal.entity === "card" || plan.withdrawal.entity === "card_and_printing"
            ? [{ entityType: "card", entityId: plan.cardId }]
            : []),
          ...(plan.printingId !== null &&
          (plan.withdrawal.entity === "printing" || plan.withdrawal.entity === "card_and_printing")
            ? [{ entityType: "printing", entityId: plan.printingId }]
            : []),
        ];
        while (cursor.target < targets.length) {
          const target = targets[cursor.target]!;
          const id = `${target.entityType}:${target.entityId}`;
          await withdrawals.seed(id, {
            id,
            value: {
              entity_type: target.entityType,
              entity_id: target.entityId,
              assertion: plan.withdrawal.assertion,
              state: plan.withdrawal.state,
              effective_at: plan.withdrawal.effective_at,
            },
          });
          cursor.target++;
          await tick();
        }
      }
      cursor.after = plan.sourceObservationId;
      cursor.membership = 0;
      cursor.target = 0;
      cursor.processedPlans++;
      await tick();
    }
    await advance("complete");
  }
  return { memberships, withdrawals };
}
