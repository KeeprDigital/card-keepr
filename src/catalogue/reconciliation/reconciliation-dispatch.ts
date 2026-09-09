import { independentGamePreparationResult, type NativeOperationResult } from "./game-reconciliation-outcome";
import { canonicalJson, type CatalogueStore, guardedCatalogueStore, sha256Text } from "../shared";
import { reconciliationCheckpoint, retainReconciliationCheckpoint } from "./reconciliation-checkpoint";
import {
  reconciliationOperationHeaderStatement,
  reconciliationWriterGuard,
} from "./reconciliation-progress-repository";
import { documentStorage } from "./reconciliation-document";
import { reserveReconciliationWorkAttemptStatement } from "./reconciliation-checkpoint-repository";
import type { ReconciliationWorkflowParams } from "./reconciliation-workflow";

export async function reconciliationDispatchState(database: CatalogueStore, params: ReconciliationWorkflowParams) {
  const operation = await reconciliationOperationHeaderStatement(
    database,
    params.preparation_id ?? params.ingestion_run_id,
  ).first<NativeOperationResult & { deadline: string }>();
  const checkpoint = await reconciliationCheckpoint<{ id: string; params: ReconciliationWorkflowParams }>(
    database,
    params.preparation_id ?? params.ingestion_run_id,
    `workflow_dispatch:${params.generation ?? 0}`,
  );
  return {
    operation,
    terminal: independentGamePreparationResult(
      params.preparation_id ?? params.ingestion_run_id,
      operation,
      params.generation ?? 0,
    ),
    successor: checkpoint && checkpoint.ordinal > (params.shard?.ordinal ?? 0) ? checkpoint.value : null,
  };
}

/** A lost dispatch response must recover this exact successor and its immutable parameters. */
export async function retainReconciliationDispatch(database: CatalogueStore, params: ReconciliationWorkflowParams) {
  const shard = params.shard;
  if (!shard || !Number.isSafeInteger(shard.ordinal) || shard.ordinal < 1)
    throw new Error("Invalid reconciliation shard ordinal.");
  const generation = params.generation ?? 0;
  const id = `reconcile-shard-${await sha256Text(
    canonicalJson({
      run: params.preparation_id ?? params.ingestion_run_id,
      generation,
      ordinal: shard.ordinal,
    }),
  )}`;
  const guarded = guardedCatalogueStore(database, () =>
    reconciliationWriterGuard(database, params.preparation_id ?? params.ingestion_run_id, generation),
  );
  await retainReconciliationCheckpoint(
    guarded,
    params.preparation_id ?? params.ingestion_run_id,
    `workflow_dispatch:${generation}`,
    shard.ordinal,
    { id, params },
  );
  return id;
}

/** Charge before every actual callback attempt, including attempts whose result is lost. */
export async function reserveReconciliationWorkAttempt(database: CatalogueStore, params: ReconciliationWorkflowParams) {
  const runId = params.preparation_id ?? params.ingestion_run_id;
  const generation = params.generation ?? 0;
  const guarded = guardedCatalogueStore(database, () => reconciliationWriterGuard(database, runId, generation));
  const row = await documentStorage(() =>
    reserveReconciliationWorkAttemptStatement(guarded, runId, generation, params.shard?.ordinal ?? 0).first<{
      reserved_calls: number;
    }>(),
  );
  return row?.reserved_calls ?? null;
}
