import { AdministrationProblem, canonicalJson, type CatalogueStore, sha256Text, workflowDriver } from "../shared";
import { assertIdentifier } from "../source-evidence";
import { inspectGameCandidate } from "./game-candidate";
import { synchronizeGameCandidatePauseStatement } from "./game-candidate-repository";
import {
  gamePreparationResumeGuardStatement,
  type GamePreparationIntent,
  gamePreparationRequestStatement,
  gamePreparationRequestByIdStatement,
  releaseGamePreparationSlotStatement,
} from "./game-reconciliation-repository";
import { initializeReconciliationProgress } from "./reconciliation-progress";
import {
  reconciliationActionStatement,
  reconciliationActionGuard,
  reconciliationActionUpdate,
  retainReconciliationAction,
} from "./reconciliation-progress-repository";
import type { ReconciliationWorkflowParams } from "./reconciliation-workflow";

type RequestRow = {
  preparation_id: string;
  request_json: string;
  workflow_params_json: string;
  workflow_instance_id: string;
};

export async function createGameReconciliation(
  database: CatalogueStore,
  workflow: Workflow<ReconciliationWorkflowParams>,
  input: GamePreparationIntent,
  at: string,
) {
  for (const [field, value] of Object.entries(input)) assertIdentifier(value, field);
  if (!["one-piece", "fusion-world", "digimon", "gundam"].includes(input.supported_game))
    throw new AdministrationProblem(422, "unsupported_game", "Select a Supported Game.");
  const requestJson = canonicalJson(input);
  const replay = await gamePreparationRequestStatement(database, input.idempotency_key).first<RequestRow>();
  if (replay) {
    assertRequest(replay, requestJson);
    await dispatchGamePreparation(database, workflow, replay);
    return { created: false, document: await inspectGameCandidate(database, replay.preparation_id) };
  }
  const digest = await sha256Text(requestJson);
  const id = `candidate_${digest}`;
  const workflowId = `game-reconcile-${digest}`;
  const params: ReconciliationWorkflowParams = {
    ingestion_run_id: input.ingestion_run_id,
    preparation_id: id,
    expected_current_revision_id: input.expected_game_revision_id,
    idempotency_key: input.idempotency_key,
    observed_at: at,
  };
  try {
    await initializeReconciliationProgress(database, id, at, {
      ...input,
      id,
      requestJson,
      workflowParamsJson: canonicalJson(params),
      workflowId,
    });
  } catch (error) {
    const winner = await gamePreparationRequestStatement(database, input.idempotency_key).first<RequestRow>();
    if (winner) {
      assertRequest(winner, requestJson);
      await dispatchGamePreparation(database, workflow, winner);
      return { created: false, document: await inspectGameCandidate(database, winner.preparation_id) };
    }
    if (error instanceof Error) {
      for (const code of [
        "game_evidence_not_found",
        "game_revision_mismatch",
        "game_candidate_slot_occupied",
        "recovery_not_verified",
      ])
        if (error.message.includes(code))
          throw new AdministrationProblem(
            code === "game_evidence_not_found" ? 404 : 409,
            code,
            "Inspect the selected game's evidence, predecessor, and current candidate before preparing it.",
          );
    }
    throw error;
  }
  const retained = await gamePreparationRequestStatement(database, input.idempotency_key).first<RequestRow>();
  if (!retained) throw new Error("The game preparation request was not retained.");
  assertRequest(retained, requestJson);
  await dispatchGamePreparation(database, workflow, retained, true);
  return { created: true, document: await inspectGameCandidate(database, id) };
}

function assertRequest(row: RequestRow, request: string) {
  if (row.request_json !== request)
    throw new AdministrationProblem(409, "idempotency_conflict", "This key binds another game preparation intent.");
}

async function dispatchGamePreparation(
  database: CatalogueStore,
  workflow: Workflow<ReconciliationWorkflowParams>,
  request: RequestRow,
  createRequested = false,
) {
  const candidate = await inspectGameCandidate(database, request.preparation_id);
  if (candidate.state !== "preparing") return;
  const generation = Number(candidate.generation);
  const params = JSON.parse(request.workflow_params_json) as ReconciliationWorkflowParams;
  await workflowDriver(workflow).ensure(
    generation === 0 ? request.workflow_instance_id : `${request.workflow_instance_id}-g${generation}`,
    { ...params, generation },
    { createRequested },
  );
}

export async function changeGameReconciliation(
  database: CatalogueStore,
  workflow: Workflow<ReconciliationWorkflowParams>,
  id: string,
  action: "pause" | "resume" | "abandon",
  input: { generation: number; idempotency_key: string },
  at: string,
) {
  if (!Number.isSafeInteger(input.generation) || input.generation < 0)
    throw new AdministrationProblem(422, "invalid_generation", "Use the generation returned by candidate inspection.");
  assertIdentifier(input.idempotency_key, "idempotency_key");
  const retained = await gamePreparationRequestByIdStatement(database, id).first<RequestRow>();
  if (!retained)
    throw new AdministrationProblem(
      404,
      "game_preparation_not_found",
      "This candidate has no independent preparation operation.",
    );
  const request = canonicalJson({ preparation_id: id, action, ...input });
  const replay = await reconciliationActionStatement(database, input.idempotency_key).first<{
    request_json: string;
    result_json: string;
  }>();
  if (replay) {
    if (replay.request_json !== request)
      throw new AdministrationProblem(409, "idempotency_conflict", "This key binds another preparation action.");
    if (action === "resume") await dispatchGamePreparation(database, workflow, retained);
    return JSON.parse(replay.result_json) as Record<string, unknown>;
  }
  const current = await inspectGameCandidate(database, id);
  if (action === "resume" && Date.parse(String(current.deadline)) <= Date.parse(at))
    throw new AdministrationProblem(
      409,
      "reconciliation_deadline_expired",
      "Abandon the expired candidate before creating a fresh preparation.",
    );
  const result = {
    ...current,
    state: action === "pause" ? "paused" : action === "resume" ? "preparing" : "abandoned",
    generation: input.generation + (action === "resume" ? 0 : 1),
  };
  try {
    await database.batch([
      reconciliationActionGuard(database, id, action, input.generation),
      ...(action === "resume" ? [gamePreparationResumeGuardStatement(database, id, at)] : []),
      reconciliationActionUpdate(database, id, action, input.generation),
      synchronizeGameCandidatePauseStatement(database, id),
      ...(action === "abandon" ? [releaseGamePreparationSlotStatement(database, id)] : []),
      retainReconciliationAction(database, id, input.idempotency_key, request, canonicalJson(result)),
    ]);
  } catch (error) {
    const winner = await reconciliationActionStatement(database, input.idempotency_key).first<{
      request_json: string;
      result_json: string;
    }>();
    if (winner?.request_json === request) {
      if (action === "resume") await dispatchGamePreparation(database, workflow, retained);
      return JSON.parse(winner.result_json) as Record<string, unknown>;
    }
    if (winner)
      throw new AdministrationProblem(409, "idempotency_conflict", "This key binds another preparation action.");
    if (error instanceof Error) {
      for (const code of ["game_revision_mismatch", "reconciliation_deadline_expired", "recovery_not_verified"])
        if (error.message.includes(code))
          throw new AdministrationProblem(
            409,
            code,
            "The preparation's original predecessor, deadline, or recovery condition no longer permits resumption.",
          );
    }
    if (error instanceof Error && error.message.includes("reconciliation_generation_conflict"))
      throw new AdministrationProblem(
        409,
        "reconciliation_generation_conflict",
        "Inspect the candidate's current state and generation.",
      );
    throw error;
  }
  if (action === "resume") await dispatchGamePreparation(database, workflow, retained, true);
  return result;
}
