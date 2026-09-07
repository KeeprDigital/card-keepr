import { canonicalJson, type CatalogueStore, guardedCatalogueStore, sha256Text } from "../shared";
import { reconciliationCheckpoint, retainReconciliationCheckpoint } from "./reconciliation-checkpoint";
import {
  reconciliationOperationHeaderStatement,
  reconciliationWriterGuard,
} from "./reconciliation-progress-repository";
import type { ReconciliationWorkflowParams } from "./reconciliation-workflow";

export async function reconciliationDispatchState(database: CatalogueStore, params: ReconciliationWorkflowParams) {
  const operation = await reconciliationOperationHeaderStatement(database, params.ingestion_run_id).first<{
    state: string;
    generation: number;
    candidate_digest: string | null;
    deadline: string;
  }>();
  const checkpoint = await reconciliationCheckpoint<{ id: string; params: ReconciliationWorkflowParams }>(
    database,
    params.ingestion_run_id,
    `workflow_dispatch:${params.generation ?? 0}`,
  );
  return {
    operation,
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
      run: params.ingestion_run_id,
      generation,
      ordinal: shard.ordinal,
    }),
  )}`;
  const guarded = guardedCatalogueStore(database, () =>
    reconciliationWriterGuard(database, params.ingestion_run_id, generation),
  );
  await retainReconciliationCheckpoint(
    guarded,
    params.ingestion_run_id,
    `workflow_dispatch:${generation}`,
    shard.ordinal,
    { id, params },
  );
  return id;
}
