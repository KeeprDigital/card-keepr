import { logProtectedFailure } from "../../http/protected-failure";
import { type CatalogueStore, sha256Text, workflowDriver } from "../shared";
import type { ReconciliationWorkflowParams } from "./reconciliation-workflow";
import {
  advancePublicationPreparation,
  inspectPublicationPreparation,
  pausePublicationWorkflow,
} from "./publication-preparation";
import type { PublicationPreparationIntent } from "./publication-preparation-types";

export type PublicationPreparationWorkflow = {
  candidate_id: string;
  manifest_digest: string;
  generation: number;
  first_sequence: number;
};

export async function dispatchPublicationPreparation(
  workflow: Workflow<ReconciliationWorkflowParams>,
  params: ReconciliationWorkflowParams,
) {
  const work = params.publication_preparation!;
  const id = `publication-${await sha256Text(`${work.candidate_id}:${work.generation}:${work.first_sequence}`)}`;
  return { id, ...(await workflowDriver(workflow).ensure(id, params, { createRequested: true })) };
}

export async function startPublicationPreparation(
  env: {
    CATALOGUE_DB: CatalogueStore;
    PRINTING_IMAGES: R2Bucket;
    CATALOGUE_EXPORTS: R2Bucket;
    RECONCILIATION_WORKFLOW: Workflow<ReconciliationWorkflowParams>;
  },
  id: string,
  input: PublicationPreparationIntent,
  at: string,
) {
  const receipt = await advancePublicationPreparation(env, id, input, at);
  const status = await inspectPublicationPreparation(env.CATALOGUE_DB, id);
  if (status.state !== "preparing") return { preparation: status, workflow: null };
  const params: ReconciliationWorkflowParams = {
    ingestion_run_id: status.ingestion_run_id,
    preparation_id: status.preparation_id,
    expected_current_revision_id: status.expected_game_revision_id,
    idempotency_key: input.idempotency_key,
    observed_at: at,
    publication_preparation: {
      candidate_id: id,
      manifest_digest: input.manifest_digest,
      generation: input.generation,
      first_sequence: Number(receipt.sequence),
    },
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const workflow = await dispatchPublicationPreparation(env.RECONCILIATION_WORKFLOW, params);
      return { preparation: status, workflow: { id: workflow.id, status: workflow.status.status } };
    } catch (error) {
      if (attempt < 2) continue;
      await logProtectedFailure("ingestion", `publication-dispatch-${id}`, error);
      await pausePublicationWorkflow(
        env,
        id,
        input.manifest_digest,
        input.generation,
        "publication_dispatch_retry_exhausted",
        { sequence: Number(receipt.sequence) },
      );
    }
  }
  return { preparation: await inspectPublicationPreparation(env.CATALOGUE_DB, id), workflow: null };
}
