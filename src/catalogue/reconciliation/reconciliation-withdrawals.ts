import { type CatalogueStore, canonicalJson } from "../shared";
import { ReconciliationContinuation } from "./reconciliation-continuation";
import { reconciliationCheckpoint, retainReconciliationCheckpoint } from "./reconciliation-checkpoint";
import { type ObservationPlan, ReconciliationPlanState } from "./reconciliation-plan-state";
import { ReconciliationReducerIndex, ReconciliationReducerStorageError } from "./reconciliation-reducer-state";
import { publishedWithdrawalAssertionsStatement } from "./reconciliation-read-repository";
import type { ReconciliationRecordSink } from "./reconciliation-record-collection";

type WithdrawalDiagnostic = {
  code: "withdrawal_evidence_conflict";
  source_observation_id: string | null;
  locator: string | null;
  matched_printing_ids: string[];
  detail: string;
};
type Assertion = { id: string; semantic: string; observationId: string; conflict: boolean };
type Cursor = {
  stage: "assertions" | "conflicts" | "published" | "complete";
  after: string;
  assertions: number;
  diagnostics: { position: number; count: number };
  processedPlans: number;
};

/** Withdrawal comparisons preserve their completed prefix across returning Workflow work units. */
export async function prepareWithdrawalDiagnostics(
  database: CatalogueStore,
  runId: string,
  plans: ReconciliationPlanState,
  diagnostics: ReconciliationRecordSink<WithdrawalDiagnostic> & {
    readonly cursor: { position: number; count: number };
    resumeAt(cursor: { position: number; count: number }): void;
  },
  hasWithdrawals: boolean,
  yieldAtCheckpoint: boolean,
): Promise<void> {
  const checkpoint = await reconciliationCheckpoint<Cursor>(database, runId, "withdrawal_diagnostics");
  const assertions = new ReconciliationReducerIndex<Assertion>(database, runId, "withdrawal_assertion_groups");
  let stage: Cursor["stage"] = checkpoint?.value.stage ?? (hasWithdrawals ? "assertions" : "complete");
  let after = checkpoint?.value.after ?? "";
  let processedPlans = checkpoint?.value.processedPlans ?? 0;
  let ordinal = (checkpoint?.ordinal ?? -1) + 1;
  if (checkpoint) {
    assertions.resumeAt(checkpoint.value.assertions);
    diagnostics.resumeAt(checkpoint.value.diagnostics);
    if (stage === "complete") return;
  }
  const save = async () => {
    await retainReconciliationCheckpoint(database, runId, "withdrawal_diagnostics", ordinal, {
      stage,
      after,
      assertions: assertions.position,
      diagnostics: diagnostics.cursor,
      processedPlans,
    } satisfies Cursor);
    if (yieldAtCheckpoint) throw new ReconciliationContinuation({ phase: "withdrawal_diagnostics", ordinal });
    ordinal++;
  };
  if (!checkpoint) await save();
  let records = 0;
  let bytes = 0;
  const budget = async (value: unknown) => {
    const size = new TextEncoder().encode(canonicalJson(value)).byteLength;
    if (records > 0 && (records >= 4 || bytes + size > 512000)) {
      await save();
      records = 0;
      bytes = 0;
    }
    records++;
    bytes += size;
  };
  if (stage === "assertions") {
    for await (const plan of plans.values(after)) {
      await budget(plan);
      await retainAssertion(assertions, plan);
      after = plan.sourceObservationId;
      processedPlans++;
    }
    stage = "conflicts";
    after = "";
    await save();
    records = 0;
    bytes = 0;
  }
  if (stage === "conflicts") {
    for await (const assertion of assertions.entityValues(after)) {
      await budget(assertion);
      if (assertion.conflict)
        await diagnostics.push({
          code: "withdrawal_evidence_conflict",
          source_observation_id: assertion.observationId,
          locator: null,
          matched_printing_ids: assertion.id.startsWith("printing:") ? [assertion.id.slice("printing:".length)] : [],
          detail:
            "Retained explicit withdrawal assertions conflict for the same entity and cannot be deterministically reconciled.",
        });
      after = assertion.id;
    }
    stage = "published";
    after = "";
    await save();
    records = 0;
    bytes = 0;
  }
  if (stage === "published") {
    for await (const plan of plans.values(after)) {
      await budget(plan);
      const single = {
        async *[Symbol.asyncIterator]() {
          yield plan;
        },
      };
      for await (const diagnostic of publishedWithdrawalConflictDiagnostics(database, single))
        await diagnostics.push(diagnostic);
      after = plan.sourceObservationId;
    }
    stage = "complete";
    after = "";
    await save();
  }
}

async function retainAssertion(assertions: ReconciliationReducerIndex<Assertion>, plan: ObservationPlan) {
  const withdrawal = plan.withdrawal;
  if (withdrawal === null) return;
  const targets = [
    ...(withdrawal.entity === "card" || withdrawal.entity === "card_and_printing" ? [`card:${plan.cardId}`] : []),
    ...(plan.printingId !== null && (withdrawal.entity === "printing" || withdrawal.entity === "card_and_printing")
      ? [`printing:${plan.printingId}`]
      : []),
  ];
  for (const target of targets) {
    const semantic = canonicalJson({
      assertion: withdrawal.assertion,
      state: withdrawal.state,
      effective_at: withdrawal.effective_at,
    });
    const prior = await assertions.get(target);
    await assertions.seed(target, {
      id: target,
      semantic: prior?.semantic ?? semantic,
      observationId:
        prior && prior.observationId < plan.sourceObservationId ? prior.observationId : plan.sourceObservationId,
      conflict: (prior?.conflict ?? false) || (prior !== undefined && prior.semantic !== semantic),
    });
  }
}

async function* publishedWithdrawalConflictDiagnostics(
  database: CatalogueStore,
  plans: AsyncIterable<ObservationPlan>,
): AsyncGenerator<WithdrawalDiagnostic> {
  for await (const plan of plans) {
    const withdrawal = plan.withdrawal;
    if (withdrawal === null) continue;
    const targets = [
      ...(withdrawal.entity === "card" || withdrawal.entity === "card_and_printing"
        ? [{ entityType: "card", entityId: plan.cardId }]
        : []),
      ...(plan.printingId !== null && (withdrawal.entity === "printing" || withdrawal.entity === "card_and_printing")
        ? [{ entityType: "printing", entityId: plan.printingId }]
        : []),
    ];
    for (const target of targets) {
      let latest: { assertion: string; state: string; effective_at: string } | null;
      try {
        latest = await publishedWithdrawalAssertionsStatement(database, {
          entityType: target.entityType,
          entityId: target.entityId,
        }).first<{ assertion: string; state: string; effective_at: string }>();
      } catch (cause) {
        throw new ReconciliationReducerStorageError(cause);
      }
      const proposedSemantic = canonicalJson({
        assertion: withdrawal.assertion,
        state: withdrawal.state,
        effective_at: withdrawal.effective_at,
      });
      const repeated = latest !== null && canonicalJson(latest) === proposedSemantic;
      const transition =
        latest !== null && latest.state !== withdrawal.state && withdrawal.effective_at > latest.effective_at;
      if ((latest === null && withdrawal.state === "reinstated") || (latest !== null && !repeated && !transition)) {
        yield {
          code: "withdrawal_evidence_conflict",
          source_observation_id: plan.sourceObservationId,
          locator: null,
          matched_printing_ids: target.entityType === "printing" ? [target.entityId] : [],
          detail:
            "The explicit withdrawal assertion conflicts with the published withdrawal history for this identity.",
        };
      }
    }
  }
}
