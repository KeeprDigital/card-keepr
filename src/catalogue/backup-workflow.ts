import { AdministrationProblem } from "./administration-problem.mjs";
import {
  failActiveCatalogueBackupAttempt,
  validateCatalogueBackupRetryEvidence,
} from "./backup-recovery";
import { canonicalJson, sha256Text } from "./serialization";

export type CatalogueBackupWorkflowParams = Readonly<{
  expected_current_revision_id: string;
  idempotency_key: string;
  observed_at: string;
  failed_attempt_id?: string;
  failed_attempt_digest?: string;
}>;

type BackupWorkflowRequest = CatalogueBackupWorkflowParams & Readonly<{
  request_json: string;
  workflow_params_json: string;
  workflow_instance_id: string;
}>;

export async function startOrObserveCatalogueBackupWorkflow(
  database: D1Database,
  workflow: Workflow<CatalogueBackupWorkflowParams>,
  input: Omit<CatalogueBackupWorkflowParams, "observed_at">,
  observedAt: string,
): Promise<{ created: boolean; document: Record<string, unknown> }> {
  const requestJson = canonicalJson(input);
  let stored = await workflowRequest(database, input.idempotency_key);
  if (stored === null) {
    const state = await database.prepare(
      `SELECT catalogue.current_revision_id,
              operation.active_ingestion_run_id,
              operation.recovery_health,
              EXISTS (
                SELECT 1 FROM catalogue_backup_attempts
                WHERE idempotency_key = ?
                  AND publication_ingestion_run_id IS NOT NULL
              ) AS publication_attempt
       FROM catalogue_state AS catalogue
       JOIN operation_state AS operation ON operation.singleton = 1
       WHERE catalogue.singleton = 1`,
    ).bind(input.idempotency_key).first<{
      current_revision_id: string;
      active_ingestion_run_id: string | null;
      recovery_health: string;
      publication_attempt: number;
    }>();
    if (state?.current_revision_id !== input.expected_current_revision_id) {
      throw new AdministrationProblem(
        409,
        "current_revision_mismatch",
        "The expected current Catalogue Revision is stale.",
      );
    }
    if (
      state.active_ingestion_run_id !== null && state.publication_attempt !== 1
    ) {
      throw new AdministrationProblem(
        409,
        "maintenance_not_idle",
        "Catalogue backup requires idle ingestion.",
      );
    }
    if (state.recovery_health === "blocked") {
      throw new AdministrationProblem(
        409,
        "backup_in_progress",
        "Catalogue recovery operation is unavailable.",
      );
    }
    await validateCatalogueBackupRetryEvidence(database, {
      expectedCurrentRevisionId: input.expected_current_revision_id,
      failedAttemptId: input.failed_attempt_id,
      failedAttemptDigest: input.failed_attempt_digest,
    });
    const params: CatalogueBackupWorkflowParams = {
      ...input,
      observed_at: observedAt,
    };
    const workflowInstanceId =
      `backup-${(await sha256Text(requestJson)).slice(0, 64)}`;
    const inserted = await database.prepare(
      `INSERT OR IGNORE INTO catalogue_backup_workflow_requests (
         idempotency_key, expected_current_revision_id, request_json,
         workflow_params_json, workflow_instance_id, observed_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      input.idempotency_key,
      input.expected_current_revision_id,
      requestJson,
      canonicalJson(params),
      workflowInstanceId,
      observedAt,
    ).run();
    stored = await workflowRequest(database, input.idempotency_key);
    if (stored === null) throw new Error("Backup Workflow request was not retained.");
    assertExactReplay(stored, requestJson);
    return {
      created: inserted.meta.changes === 1,
      document: await publicWorkflowDocument(
        database,
        workflow,
        stored,
        inserted.meta.changes === 1,
      ),
    };
  }
  assertExactReplay(stored, requestJson);
  return {
    created: false,
    document: await publicWorkflowDocument(database, workflow, stored),
  };
}

async function publicWorkflowDocument(
  database: D1Database,
  workflow: Workflow<CatalogueBackupWorkflowParams>,
  request: BackupWorkflowRequest,
  createRequested = false,
): Promise<Record<string, unknown>> {
  let instance: WorkflowInstance | null = null;
  if (!createRequested) {
    try {
      instance = await workflow.get(request.workflow_instance_id);
      if ((await instance.status()).status === "unknown") instance = null;
    } catch {
      instance = null;
    }
  }
  if (instance === null) {
    try {
      instance = await workflow.create({
        id: request.workflow_instance_id,
        params: storedParams(request),
      });
    } catch {
      instance = await workflow.get(request.workflow_instance_id);
    }
  }
  let status = await instance.status();
  if (status.status === "paused") {
    try {
      await instance.resume();
    } catch {
      // An exact concurrent replay may already have resumed it.
    }
    status = await instance.status();
  }
  let publicStatus = status.status;
  let output: ReturnType<typeof workflowOutput> | null = null;
  if (status.status === "errored" || status.status === "terminated") {
    const detail = status.error?.message ??
      `The backup Workflow became ${status.status}.`;
    await failActiveCatalogueBackupAttempt(
      database,
      request.idempotency_key,
      request.observed_at,
      detail,
    );
    publicStatus = "complete";
    output = {
      ok: false,
      code: "backup_failed",
      detail,
    };
  }
  if (status.status === "complete") {
    try {
      output = workflowOutput(status.output, request);
    } catch {
      output = await retainedBackupOutcome(database, request);
    }
  }
  return {
    contract: "card-keepr-catalogue-backup-workflow@1",
    expected_current_revision_id: request.expected_current_revision_id,
    idempotency_key: request.idempotency_key,
    workflow_instance_id: request.workflow_instance_id,
    status: publicStatus,
    output: publicWorkflowOutput(output),
  };
}

function publicWorkflowOutput(
  output: ReturnType<typeof workflowOutput> | null,
): Record<string, unknown> | null {
  if (output === null) return null;
  if (output.ok) return output.document;
  return {
    contract: "card-keepr-catalogue-backup-workflow-failure@1",
    code: output.code,
    detail: output.detail,
  };
}

function workflowOutput(
  value: unknown,
  request: BackupWorkflowRequest,
): { ok: true; document: Record<string, unknown> } |
  { ok: false; code: string; detail: string } {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    !("result_json" in value) || typeof value.result_json !== "string"
  ) throw new Error("The backup Workflow output is invalid.");
  const result = JSON.parse(value.result_json) as Record<string, unknown>;
  if (
    result.contract !== "card-keepr-catalogue-backup-workflow-result@1" ||
    result.idempotency_key !== request.idempotency_key ||
    typeof result.ok !== "boolean"
  ) throw new Error("The backup Workflow output is invalid.");
  if (result.ok === true && isRecord(result.document)) {
    if (
      result.document.contract !== "card-keepr-catalogue-backup@1" ||
      result.document.catalogue_revision_id !==
        request.expected_current_revision_id ||
      result.document.verified !== true
    ) throw new Error("The backup Workflow output is invalid.");
    return { ok: true, document: result.document };
  }
  if (
    result.ok === false && typeof result.code === "string" &&
    typeof result.detail === "string"
  ) return { ok: false, code: result.code, detail: result.detail };
  throw new Error("The backup Workflow output is invalid.");
}

async function retainedBackupOutcome(
  database: D1Database,
  request: BackupWorkflowRequest,
): Promise<ReturnType<typeof workflowOutput>> {
  const attempt = await database.prepare(
    `SELECT attempt.state, attempt.catalogue_revision_id, attempt.object_key,
            attempt.d1_bookmark, attempt.failure_code, attempt.failure_detail,
            attempt.content_sha256, attempt.manifest_key,
            attempt.manifest_sha256, attempt.linked_attempt_id,
            retention.newest_success, retention.retain_until
     FROM catalogue_backup_attempts AS attempt
     LEFT JOIN catalogue_backup_retention AS retention
       ON retention.attempt_id = attempt.idempotency_key
     WHERE attempt.idempotency_key = ?`,
  ).bind(request.idempotency_key).first<{
    state: string;
    catalogue_revision_id: string;
    object_key: string;
    d1_bookmark: string | null;
    failure_code: string | null;
    failure_detail: string | null;
    content_sha256: string | null;
    manifest_key: string | null;
    manifest_sha256: string | null;
    linked_attempt_id: string | null;
    newest_success: number | null;
    retain_until: string | null;
  }>();
  if (
    attempt?.state === "verified" && attempt.d1_bookmark !== null &&
    attempt.catalogue_revision_id === request.expected_current_revision_id &&
    attempt.content_sha256 !== null && attempt.manifest_key !== null &&
    attempt.manifest_sha256 !== null && attempt.newest_success !== null
  ) {
    return {
      ok: true,
      document: {
        contract: "card-keepr-catalogue-backup@1",
        catalogue_revision_id: attempt.catalogue_revision_id,
        object_key: attempt.object_key,
        d1_bookmark: attempt.d1_bookmark,
        content_sha256: attempt.content_sha256,
        manifest_key: attempt.manifest_key,
        manifest_sha256: attempt.manifest_sha256,
        linked_attempt_id: attempt.linked_attempt_id,
        retention: {
          newest_success: attempt.newest_success === 1,
          retain_until: attempt.retain_until,
        },
        verified: true,
      },
    };
  }
  if (attempt?.state === "failed") {
    return {
      ok: false,
      code: attempt.failure_code ?? "backup_failed",
      detail: attempt.failure_detail ?? "The retained backup attempt failed.",
    };
  }
  throw new Error("The completed backup Workflow output is unavailable.");
}

async function workflowRequest(
  database: D1Database,
  idempotencyKey: string,
): Promise<BackupWorkflowRequest | null> {
  return database.prepare(
    `SELECT idempotency_key, expected_current_revision_id, request_json,
            workflow_params_json, workflow_instance_id, observed_at
     FROM catalogue_backup_workflow_requests WHERE idempotency_key = ?`,
  ).bind(idempotencyKey).first<BackupWorkflowRequest>();
}

function storedParams(request: BackupWorkflowRequest): CatalogueBackupWorkflowParams {
  const params = JSON.parse(request.workflow_params_json) as Record<string, unknown>;
  if (
    params.expected_current_revision_id !== request.expected_current_revision_id ||
    params.idempotency_key !== request.idempotency_key ||
    params.observed_at !== request.observed_at
  ) throw new Error("The retained backup Workflow params are invalid.");
  return params as CatalogueBackupWorkflowParams;
}

function assertExactReplay(request: BackupWorkflowRequest, requestJson: string): void {
  if (request.request_json !== requestJson) {
    throw new AdministrationProblem(
      409,
      "idempotency_key_reused",
      "The backup idempotency key is bound to another request.",
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
