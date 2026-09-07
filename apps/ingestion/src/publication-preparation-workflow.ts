import { logProtectedFailure } from "../../../src/http/protected-failure";
import type { WorkflowStep } from "cloudflare:workers";
import {
  advancePublicationPreparation,
  inspectPublicationPreparation,
  dispatchPublicationPreparation,
  reservePublicationWork,
  pausePublicationWorkflow,
  retainPublicationFence,
  type ReconciliationWorkflowParams,
} from "../../../src/catalogue/reconciliation";
import { AdministrationProblem, catalogueEnvironment } from "../../../src/catalogue/shared";

/** Shards retain at most sixteen bounded units and dispatch their exact successor. */
export async function runPublicationPreparationWorkflow(
  env: Env,
  step: WorkflowStep,
  params: ReconciliationWorkflowParams,
) {
  try {
    return await runShard(env, step, params);
  } catch (error) {
    await logProtectedFailure(
      "ingestion",
      `publication-${params.publication_preparation!.candidate_id}-${params.publication_preparation!.first_sequence}`,
      error,
    );
    const output = await step.do(
      "retain publication retry pause",
      { retries: { limit: 3, delay: 250, backoff: "exponential" }, timeout: "1 minute" },
      async () => {
        const work = params.publication_preparation!;
        const environment = catalogueEnvironment(env);
        try {
          await pausePublicationWorkflow(
            environment,
            work.candidate_id,
            work.manifest_digest,
            work.generation,
            "publication_workflow_retry_exhausted",
          );
        } catch (error) {
          const state = await inspectPublicationPreparation(environment.CATALOGUE_DB, work.candidate_id);
          const code =
            error instanceof Error
              ? ["publication_ownership_conflict", "publication_deadline_expired", "game_revision_mismatch"].find(
                  (code) => error.message.includes(code),
                )
              : undefined;
          if (code)
            await retainPublicationFence(
              environment,
              work.candidate_id,
              work.manifest_digest,
              work.generation,
              state.sequence,
              code,
            );
          else throw error;
        }
        return JSON.stringify(await inspectPublicationPreparation(environment.CATALOGUE_DB, work.candidate_id));
      },
    );
    return { result_json: output };
  }
}

async function runShard(env: Env, step: WorkflowStep, params: ReconciliationWorkflowParams) {
  const work = params.publication_preparation!;
  let last: Record<string, unknown> = {};
  for (let unit = 0; unit < 16; unit++) {
    const sequence = work.first_sequence + unit;
    const output = await step.do(
      `prepare publication artifacts ${sequence}`,
      {
        retries: { limit: 3, delay: 250, backoff: "exponential" },
        timeout: "2 minutes",
      },
      async () => {
        const environment = catalogueEnvironment(env);
        const state = await inspectPublicationPreparation(environment.CATALOGUE_DB, work.candidate_id);
        if (state.state !== "preparing") return JSON.stringify(state);
        if (state.sequence > sequence) return JSON.stringify({ ...state, sequence: sequence + 1 });
        if (!(await reservePublicationWork(environment.CATALOGUE_DB, work.candidate_id, work.first_sequence))) {
          await pausePublicationWorkflow(
            environment,
            work.candidate_id,
            work.manifest_digest,
            work.generation,
            "publication_workflow_budget_exhausted",
          );
          return JSON.stringify(await inspectPublicationPreparation(environment.CATALOGUE_DB, work.candidate_id));
        }
        try {
          return JSON.stringify(
            await advancePublicationPreparation(
              environment,
              work.candidate_id,
              {
                manifest_digest: work.manifest_digest,
                generation: work.generation,
                sequence,
                idempotency_key: `publication-${work.candidate_id}-${work.generation}-${sequence}`,
              },
              new Date().toISOString(),
            ),
          );
        } catch (error) {
          if (error instanceof AdministrationProblem && error.status === 409) {
            if (
              ["publication_ownership_conflict", "publication_deadline_expired", "game_revision_mismatch"].includes(
                error.code,
              )
            )
              await retainPublicationFence(
                environment,
                work.candidate_id,
                work.manifest_digest,
                work.generation,
                sequence,
                error.code,
              );
            return JSON.stringify({
              ...(await inspectPublicationPreparation(environment.CATALOGUE_DB, work.candidate_id)),
              writer_fenced: true,
              failure_code: error.code,
            });
          }
          throw error;
        }
      },
    );
    last = JSON.parse(output) as Record<string, unknown>;
    if (last.state !== "preparing" || last.writer_fenced) return { result_json: output };
  }
  await step.do(
    "dispatch publication preparation successor",
    { retries: { limit: 3, delay: 250, backoff: "exponential" }, timeout: "1 minute" },
    async () => {
      const next = { ...params, publication_preparation: { ...work, first_sequence: work.first_sequence + 16 } };
      const dispatched = await dispatchPublicationPreparation(env.RECONCILIATION_WORKFLOW, next);
      return JSON.stringify({ id: dispatched.id });
    },
  );
  return {
    result_json: JSON.stringify({ candidate_id: work.candidate_id, state: "preparing", sequence: last.sequence }),
  };
}
