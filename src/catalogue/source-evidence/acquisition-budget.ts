import { AdministrationProblem, canonicalJson, type CatalogueStore, sha256, utf8 } from "../shared";
import {
  acquisitionAccount,
  acquisitionExtensionGuard,
  acquisitionIntegrityGuard,
  acquisitionPause,
  acquisitionPauseStatements,
  acquisitionPolicyByKey,
  captureDispatch,
  initialAcquisitionAccount,
  insertAcquisitionPolicy,
  reserveSourceDispatch,
  settleSourceDispatch,
  unsettledDispatches,
  unsettledRequestDispatch,
  type AcquisitionAccount,
  type AcquisitionDimension,
  type AcquisitionPause,
  type DispatchReservation,
} from "./acquisition-budget-repository";
import { assertIdentifier, type AcquisitionBudget, type CollectionWorkflowAttempt } from "./source-evidence-model";

export function validateAcquisitionBudget(value: AcquisitionBudget, requireFuture = true): AcquisitionBudget {
  if (
    !value ||
    !Number.isSafeInteger(value.max_dispatches) ||
    value.max_dispatches < 1 ||
    !Number.isSafeInteger(value.max_source_bytes) ||
    value.max_source_bytes < 1 ||
    typeof value.dispatch_deadline !== "string" ||
    !Number.isFinite(Date.parse(value.dispatch_deadline)) ||
    (requireFuture && Date.parse(value.dispatch_deadline) <= Date.now())
  ) {
    throw new AdministrationProblem(
      422,
      "acquisition_budget_invalid",
      "An explicit finite acquisition budget with positive safe-integer limits and a future dispatch deadline is required.",
    );
  }
  return {
    max_dispatches: value.max_dispatches,
    max_source_bytes: value.max_source_bytes,
    dispatch_deadline: new Date(value.dispatch_deadline).toISOString(),
  };
}

export async function initialAcquisitionStatements(
  db: CatalogueStore,
  runId: string,
  key: string,
  budget: AcquisitionBudget,
  at: string,
) {
  return [
    initialAcquisitionAccount(db, runId, at, false, 0),
    insertAcquisitionPolicy(db, {
      runId,
      generation: 1,
      budget,
      at,
      key,
      digest: await sha256(utf8(canonicalJson(budget))),
      response: "{}",
    }),
  ];
}

export async function verifyInitialAcquisitionIntent(db: CatalogueStore, key: string, budget: AcquisitionBudget) {
  const row = await acquisitionPolicyByKey(db, key).first<{ request_digest: string }>();
  if (row === null || row.request_digest !== (await sha256(utf8(canonicalJson(budget)))))
    throw new AdministrationProblem(
      409,
      "idempotency_key_reused",
      "The idempotency key was already used with a different acquisition budget.",
    );
}

function limitingDimension(account: AcquisitionAccount | null, bytes: number): AcquisitionDimension | null {
  if (account === null) return "policy_missing";
  if (Date.parse(account.dispatch_deadline) <= Date.now()) return "deadline";
  if (account.charged_dispatches >= account.max_dispatches) return "dispatches";
  if (bytes > account.max_source_bytes - account.charged_source_bytes - account.reserved_source_bytes)
    return "source_bytes";
  return null;
}

export async function reserveAcquisitionDispatch(
  db: CatalogueStore,
  input: {
    runId: string;
    requestId: string;
    captureId: string;
    objectKey: string;
    maximumBytes: number;
    workflow?: CollectionWorkflowAttempt;
  },
): Promise<string | null> {
  const id = crypto.randomUUID();
  // A replay never returns an existing permit. Only this invocation's successful
  // insert can authorize its call; lost acknowledgements retain the full charge.
  const result = await reserveSourceDispatch(db, { ...input, id, at: new Date().toISOString() }).run();
  if (result.meta.changes > 0) return id;
  const account = await acquisitionAccount(db, input.runId).first<AcquisitionAccount>();
  const previous = await captureDispatch(db, input.captureId).first<DispatchReservation>();
  const dimension =
    previous !== null && previous.settled_at === null ? "ownership" : limitingDimension(account, input.maximumBytes);
  if (dimension !== null)
    await db.batch(
      acquisitionPauseStatements(db, {
        ...input,
        generation: account?.generation ?? null,
        dimension,
      }),
    );
  return null;
}

export async function settleAcquisitionDispatch(db: CatalogueStore, id: string, captureId: string, bytes: number) {
  await settleSourceDispatch(db, id, captureId, bytes, new Date().toISOString()).run();
}

export async function inspectAcquisitionBudget(db: CatalogueStore, runId: string) {
  const account = await acquisitionAccount(db, runId).first<AcquisitionAccount>();
  if (account === null) return null;
  const outstanding = await unsettledDispatches(db, runId).all<DispatchReservation>();
  return {
    generation: account.generation,
    coverage_started_at: account.coverage_started_at,
    historical_dispatches_unknown: account.historical_dispatches_unknown === 1,
    baseline_source_bytes: account.baseline_source_bytes,
    budget: {
      max_dispatches: account.max_dispatches,
      max_source_bytes: account.max_source_bytes,
      dispatch_deadline: account.dispatch_deadline,
    },
    charged_dispatches: account.charged_dispatches,
    charged_source_bytes: account.charged_source_bytes,
    reserved_source_bytes: account.reserved_source_bytes,
    remaining_dispatches: Math.max(0, account.max_dispatches - account.charged_dispatches),
    remaining_source_bytes: Math.max(
      0,
      account.max_source_bytes - account.charged_source_bytes - account.reserved_source_bytes,
    ),
    limiting_dimension: limitingDimension(account, 1),
    unsettled: outstanding.results.slice(0, 50).map((row) => ({
      id: row.id,
      request_id: row.request_id,
      capture_operation_id: row.capture_operation_id,
      parent_workflow_id: row.parent_workflow_id,
      workflow_instance_id: row.workflow_instance_id,
      budget_generation: row.budget_generation,
      maximum_source_bytes: row.maximum_source_bytes,
      reserved_at: row.reserved_at,
    })),
    unsettled_truncated: outstanding.results.length > 50,
  };
}

export async function currentAcquisitionPause(db: CatalogueStore, runId: string) {
  const row = await acquisitionPause(db, runId).first<AcquisitionPause>();
  if (row === null) return null;
  return {
    reason: "source_acquisition_budget_exhausted",
    paused_at: row.paused_at,
    document: {
      reason: "source_acquisition_budget_exhausted",
      paused_at: row.paused_at,
      generation: row.generation,
      request_id: row.request_id,
      maximum_source_bytes: row.maximum_source_bytes,
      dimension: row.dimension,
    },
  };
}

export async function assertAcquisitionResumable(db: CatalogueStore, runId: string) {
  const account = await acquisitionAccount(db, runId).first<AcquisitionAccount>();
  const pause = await acquisitionPause(db, runId).first<AcquisitionPause>();
  const dimension = limitingDimension(account, pause?.maximum_source_bytes ?? 1);
  if (dimension !== null)
    throw new AdministrationProblem(
      409,
      "source_acquisition_budget_exhausted",
      `Collection cannot resume: acquisition ${dimension}. Initialize or extend its budget first.`,
    );
  if (pause?.dimension === "ownership") {
    if (await unsettledRequestDispatch(db, runId, pause.request_id).first())
      throw new AdministrationProblem(
        409,
        "source_acquisition_ownership_pending",
        "The prior physical dispatch has not been positively settled.",
      );
  }
}

export type AcquisitionExtensionRequest = {
  expected_generation: number;
  expected_budget: AcquisitionBudget;
  acquisition_budget: AcquisitionBudget;
  idempotency_key: string;
};
export async function extendAcquisitionBudget(db: CatalogueStore, runId: string, input: AcquisitionExtensionRequest) {
  assertIdentifier(input.idempotency_key, "idempotency_key");
  const budget = validateAcquisitionBudget(input.acquisition_budget, false);
  const previous = validateAcquisitionBudget(input.expected_budget, false);
  const digest = await sha256(
    utf8(canonicalJson({ runId, ...input, expected_budget: previous, acquisition_budget: budget })),
  );
  const replay = await acquisitionPolicyByKey(db, input.idempotency_key).first<{
    request_digest: string;
    response_json: string;
  }>();
  if (replay !== null) {
    if (replay.request_digest !== digest)
      throw new AdministrationProblem(
        409,
        "idempotency_conflict",
        "The acquisition action key has different retained intent.",
      );
    return JSON.parse(replay.response_json) as Record<string, unknown>;
  }
  const account = await acquisitionAccount(db, runId).first<AcquisitionAccount>();
  if (
    account === null ||
    account.generation !== input.expected_generation ||
    previous.max_dispatches !== account.max_dispatches ||
    previous.max_source_bytes !== account.max_source_bytes ||
    previous.dispatch_deadline !== account.dispatch_deadline
  )
    throw new AdministrationProblem(
      409,
      "acquisition_budget_mismatch",
      "The expected acquisition generation and limits must match exactly.",
    );
  if (
    budget.max_dispatches < previous.max_dispatches ||
    budget.max_source_bytes < previous.max_source_bytes ||
    budget.dispatch_deadline < previous.dispatch_deadline ||
    canonicalJson(budget) === canonicalJson(previous)
  )
    throw new AdministrationProblem(
      422,
      "acquisition_budget_not_increased",
      "An extension must increase at least one limit or deadline and decrease none.",
    );
  const at = new Date().toISOString();
  const response = {
    contract: "card-keepr-acquisition-budget-extension@1",
    ingestion_run_id: runId,
    previous_generation: account.generation,
    generation: account.generation + 1,
    previous_budget: previous,
    acquisition_budget: budget,
    extended_at: at,
  };
  try {
    await db.batch([
      acquisitionIntegrityGuard(db, runId),
      acquisitionExtensionGuard(db, runId, account.generation),
      insertAcquisitionPolicy(db, {
        runId,
        generation: response.generation,
        budget,
        at,
        key: input.idempotency_key,
        digest,
        response: canonicalJson(response),
      }),
    ]);
  } catch (error) {
    const raced = await acquisitionPolicyByKey(db, input.idempotency_key).first<{
      request_digest: string;
      response_json: string;
    }>();
    if (raced?.request_digest === digest) return JSON.parse(raced.response_json) as Record<string, unknown>;
    if (String(error).includes("acquisition_extension_conflict"))
      throw new AdministrationProblem(
        409,
        "acquisition_extension_conflict",
        "The collection state or acquisition budget changed before extension.",
      );
    throw error;
  }
  return response;
}
