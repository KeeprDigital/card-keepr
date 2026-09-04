import { canonicalJson, compareUtf8, sha256Text } from "../shared";

const PLAN_TTL_MS = 15 * 60 * 1_000;
const EXECUTION_LEASE_MS = 5 * 60 * 1_000;
const REPLAY_RESPONSE_QUERY_BUDGET = 8;
const REPLAY_WAIT_INITIAL_MS = 10;
const REPLAY_WAIT_MAX_MS = 250;

type ExportRow = {
  catalogue_revision_id: string;
  manifest_key: string;
  manifest_digest: string;
  maintenance_state: "available" | "deleting" | "deleted";
};

type PlanRow = {
  id: string;
  catalogue_revision_id: string;
  manifest_digest: string;
  expected_current_revision_id: string;
  object_keys_json: string;
  component_names_json: string;
  object_set_digest: string;
  dependencies_json: string;
  plan_digest: string;
  created_at: string;
  expires_at: string;
};

type DeletionRow = {
  id: string;
  plan_id: string;
  state: "deleting" | "deleted" | "failed";
  catalogue_revision_id: string;
  manifest_digest: string;
  expected_current_revision_id: string;
  object_set_digest: string;
  idempotency_key: string;
  request_json: string;
  requested_at: string;
  completed_at: string | null;
  failure_code: string | null;
  retry_owner_idempotency_key: string | null;
  execution_owner_token: string | null;
  execution_lease_expires_at: string | null;
  confirmation_response_json: string | null;
};

type OperationState = {
  current_revision_id: string;
  active_ingestion_run_id: string | null;
  active_production_release_id: string | null;
  active_production_release_expires_at: string | null;
  recovery_health: string;
};

export class CatalogueExportDeletionProblem extends Error {
  constructor(
    readonly status: 404 | 409 | 422,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type PrepareCatalogueExportDeletion = {
  catalogue_revision_id: string;
  manifest_digest: string;
  expected_current_revision_id: string;
  plan_id: string;
};

export type ConfirmCatalogueExportDeletion = {
  plan_id: string;
  plan_digest: string;
  catalogue_revision_id: string;
  manifest_digest: string;
  expected_current_revision_id: string;
  confirmation_revision_id: string;
  deletion_id: string;
  idempotency_key: string;
};

export async function prepareCatalogueExportDeletion(
  database: D1Database,
  bucket: R2Bucket,
  request: PrepareCatalogueExportDeletion,
  observedAt: string,
): Promise<Record<string, unknown>> {
  const catalogueExport = await database
    .prepare(
      `SELECT catalogue_revision_id, manifest_key, manifest_digest,
            maintenance_state
     FROM catalogue_exports WHERE catalogue_revision_id = ?`,
    )
    .bind(request.catalogue_revision_id)
    .first<ExportRow>();
  if (catalogueExport === null) {
    throw problem(404, "catalogue_export_not_found", "The Catalogue Export is not known.");
  }
  if (catalogueExport.maintenance_state !== "available") {
    throw problem(409, "catalogue_export_not_available", "The Catalogue Export is not available.");
  }
  if (catalogueExport.manifest_digest !== request.manifest_digest) {
    throw problem(409, "manifest_digest_mismatch", "The manifest digest does not match the retained export.");
  }
  const currentRevisionId = await currentRevision(database);
  if (currentRevisionId !== request.expected_current_revision_id) {
    throw problem(409, "current_revision_mismatch", "The expected current Catalogue Revision has changed.");
  }
  const priorPlan = await database
    .prepare("SELECT 1 AS present FROM catalogue_export_deletion_plans WHERE id = ?")
    .bind(request.plan_id)
    .first();
  if (priorPlan !== null) {
    throw problem(409, "identity_conflict", "The deletion plan identity is already in use.");
  }

  const prefix = `catalogue-exports/${request.catalogue_revision_id}/`;
  const resolvedObjects = await verifiedExportObjects(bucket, catalogueExport, prefix);
  const objectKeys = resolvedObjects.objectKeys;
  const objectSetDigest = await sha256Text(canonicalJson(objectKeys));
  const dependencies: Record<string, string>[] = [
    {
      code: "catalogue_consumers_may_depend",
      severity: "warning",
      detail: "Owner-controlled Catalogue Consumers may retain this immutable export.",
    },
    {
      code: "authenticated_urls_will_return_410",
      severity: "warning",
      detail: "Known manifest and component URLs will permanently report catalogue_export_deleted.",
    },
  ];
  if (request.catalogue_revision_id === currentRevisionId) {
    dependencies.unshift({
      code: "current_catalogue_revision",
      severity: "blocking",
      detail: "The current Catalogue Revision must retain its verified Catalogue Export.",
    });
  }
  const createdAt = new Date(observedAt).toISOString();
  const expiresAt = new Date(new Date(createdAt).valueOf() + PLAN_TTL_MS).toISOString();
  const core = {
    contract: "card-keepr-catalogue-export-deletion-plan@1",
    id: request.plan_id,
    catalogue_revision_id: request.catalogue_revision_id,
    manifest_digest: request.manifest_digest,
    expected_current_revision_id: currentRevisionId,
    object_keys: objectKeys,
    object_set_digest: objectSetDigest,
    dependencies,
    created_at: createdAt,
    expires_at: expiresAt,
  };
  const document = {
    ...core,
    plan_digest: await sha256Text(canonicalJson(core)),
  };
  await database
    .prepare(
      `INSERT INTO catalogue_export_deletion_plans (
       id, catalogue_revision_id, manifest_digest,
       expected_current_revision_id, object_keys_json, component_names_json,
       object_set_digest,
       dependencies_json, plan_digest, created_at, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      document.id,
      document.catalogue_revision_id,
      document.manifest_digest,
      document.expected_current_revision_id,
      canonicalJson(document.object_keys),
      canonicalJson(resolvedObjects.componentNames),
      document.object_set_digest,
      canonicalJson(document.dependencies),
      document.plan_digest,
      document.created_at,
      document.expires_at,
    )
    .run();
  return document;
}

export async function confirmCatalogueExportDeletion(
  database: D1Database,
  bucket: R2Bucket,
  request: ConfirmCatalogueExportDeletion,
  observedAt: string,
): Promise<Record<string, unknown>> {
  const requestJson = canonicalJson(request);
  const executionOwnerToken = crypto.randomUUID();
  const executionLeaseExpiresAt = leaseExpiresAt(observedAt);
  const replay = await database
    .prepare("SELECT * FROM catalogue_export_deletions WHERE idempotency_key = ?")
    .bind(request.idempotency_key)
    .first<DeletionRow>();
  if (replay !== null) {
    if (replay.request_json !== requestJson) {
      throw problem(409, "idempotency_key_reused", "The idempotency key is bound to another deletion request.");
    }
    if (replay.confirmation_response_json !== null) {
      return JSON.parse(replay.confirmation_response_json) as Record<string, unknown>;
    }
    if (replay.state === "deleting") {
      const claimed = await claimDeletionExecutionLease(
        database,
        replay.id,
        null,
        executionOwnerToken,
        executionLeaseExpiresAt,
        observedAt,
      );
      if (!claimed) {
        return waitForDeletionResponse(database, replay.id, null);
      }
      const replayPlan = await loadPlan(database, replay.plan_id);
      if (replayPlan === null) {
        throw new Error("Deletion plan evidence is unavailable");
      }
      const manifestKey = await database
        .prepare("SELECT manifest_key FROM catalogue_exports WHERE catalogue_revision_id = ?")
        .bind(replay.catalogue_revision_id)
        .first<string>("manifest_key");
      if (manifestKey === null) {
        throw new Error("Catalogue Export evidence is unavailable");
      }
      return executeDeletion(
        database,
        bucket,
        replay.id,
        replayPlan,
        manifestKey,
        observedAt,
        null,
        executionOwnerToken,
      );
    }
    throw new Error("Confirmation replay evidence is unavailable");
  }

  const plan = await loadPlan(database, request.plan_id);
  if (plan === null) {
    throw problem(404, "deletion_plan_not_found", "The deletion plan is not known.");
  }
  if (new Date(observedAt).valueOf() >= new Date(plan.expires_at).valueOf()) {
    throw problem(409, "deletion_plan_expired", "The deletion plan has expired.");
  }
  if (
    request.plan_digest !== plan.plan_digest ||
    request.catalogue_revision_id !== plan.catalogue_revision_id ||
    request.manifest_digest !== plan.manifest_digest ||
    request.expected_current_revision_id !== plan.expected_current_revision_id
  ) {
    throw problem(409, "deletion_plan_mismatch", "The confirmation does not match the immutable deletion plan.");
  }
  await assertMutationGuards(database, plan, request.confirmation_revision_id, observedAt);
  const catalogueExport = await database
    .prepare(
      `SELECT catalogue_revision_id, manifest_key, manifest_digest, maintenance_state
     FROM catalogue_exports WHERE catalogue_revision_id = ?`,
    )
    .bind(plan.catalogue_revision_id)
    .first<ExportRow>();
  if (
    catalogueExport === null ||
    catalogueExport.maintenance_state !== "available" ||
    catalogueExport.manifest_digest !== plan.manifest_digest
  ) {
    throw problem(409, "catalogue_export_changed", "The plan no longer names the exact available immutable export.");
  }
  const exactKeys = await listObjectKeys(bucket, `catalogue-exports/${plan.catalogue_revision_id}/`);
  const exactDigest = await sha256Text(canonicalJson(exactKeys));
  if (exactDigest !== plan.object_set_digest) {
    throw problem(409, "catalogue_export_changed", "The Catalogue Export object set changed after preparation.");
  }
  const existingIdentity = await database
    .prepare("SELECT 1 AS present FROM catalogue_export_deletions WHERE id = ?")
    .bind(request.deletion_id)
    .first();
  if (existingIdentity !== null) {
    throw problem(409, "identity_conflict", "The deletion identity is already in use.");
  }
  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO catalogue_export_deletions (
           id, plan_id, state, catalogue_revision_id, manifest_digest,
           expected_current_revision_id, object_set_digest, idempotency_key,
           request_json, requested_at, completed_at, failure_code,
           retry_owner_idempotency_key, execution_owner_token,
           execution_lease_expires_at, confirmation_response_json
         ) VALUES (?, ?, 'deleting', ?, ?, ?, ?, ?, ?, ?, NULL, NULL,
           NULL, ?, ?, NULL)`,
        )
        .bind(
          request.deletion_id,
          plan.id,
          plan.catalogue_revision_id,
          plan.manifest_digest,
          plan.expected_current_revision_id,
          plan.object_set_digest,
          request.idempotency_key,
          requestJson,
          observedAt,
          executionOwnerToken,
          executionLeaseExpiresAt,
        ),
      database
        .prepare(
          `UPDATE catalogue_exports
         SET maintenance_state = 'deleting', deletion_operation_id = ?
         WHERE catalogue_revision_id = ? AND maintenance_state = 'available'`,
        )
        .bind(request.deletion_id, plan.catalogue_revision_id),
    ]);
  } catch (error) {
    const concurrent = await database
      .prepare(
        "SELECT request_json, confirmation_response_json FROM catalogue_export_deletions WHERE idempotency_key = ?",
      )
      .bind(request.idempotency_key)
      .first<{
        request_json: string;
        confirmation_response_json: string | null;
      }>();
    if (concurrent === null || concurrent.request_json !== requestJson) throw error;
    if (concurrent.confirmation_response_json !== null) {
      return JSON.parse(concurrent.confirmation_response_json) as Record<string, unknown>;
    }
    return waitForDeletionResponse(database, request.deletion_id, null);
  }
  return executeDeletion(
    database,
    bucket,
    request.deletion_id,
    plan,
    catalogueExport.manifest_key,
    observedAt,
    null,
    executionOwnerToken,
  );
}

export async function catalogueExportDeletionStatus(
  database: D1Database,
  deletionId: string,
): Promise<Record<string, unknown>> {
  const row = await database
    .prepare("SELECT * FROM catalogue_export_deletions WHERE id = ?")
    .bind(deletionId)
    .first<DeletionRow>();
  if (row === null) {
    throw problem(404, "export_deletion_not_found", "The Catalogue Export deletion is not known.");
  }
  return deletionDocument(row);
}

export async function retryCatalogueExportDeletion(
  database: D1Database,
  bucket: R2Bucket,
  deletionId: string,
  request: { object_set_digest: string; idempotency_key: string },
  observedAt: string,
): Promise<Record<string, unknown>> {
  const requestJson = canonicalJson(request);
  const executionOwnerToken = crypto.randomUUID();
  const executionLeaseExpiresAt = leaseExpiresAt(observedAt);
  const replay = await database
    .prepare(
      `SELECT deletion_id, object_set_digest, request_json, response_json
     FROM catalogue_export_deletion_retries WHERE idempotency_key = ?`,
    )
    .bind(request.idempotency_key)
    .first<{
      deletion_id: string;
      object_set_digest: string;
      request_json: string;
      response_json: string | null;
    }>();
  if (replay !== null) {
    if (replay.deletion_id !== deletionId || replay.request_json !== requestJson) {
      throw problem(409, "idempotency_key_reused", "The idempotency key is bound to another retry request.");
    }
    if (replay.response_json !== null) {
      return JSON.parse(replay.response_json) as Record<string, unknown>;
    }
  }
  const row = await database
    .prepare("SELECT * FROM catalogue_export_deletions WHERE id = ?")
    .bind(deletionId)
    .first<DeletionRow>();
  if (row === null) {
    throw problem(404, "export_deletion_not_found", "The Catalogue Export deletion is not known.");
  }
  if (replay !== null && row.state !== "deleting") {
    const document = deletionDocument(row);
    await persistRetryResponse(database, request.idempotency_key, document);
    return document;
  }
  if (replay !== null && row.retry_owner_idempotency_key !== request.idempotency_key) {
    throw problem(409, "export_deletion_not_failed", "Another retry owns the active deletion attempt.");
  }
  if (replay === null && row.state !== "failed") {
    throw problem(409, "export_deletion_not_failed", "Only a failed deletion can be retried.");
  }
  if (row.object_set_digest !== request.object_set_digest) {
    throw problem(409, "deleted_object_set_mismatch", "Retry must use the original object-set digest.");
  }
  if (replay !== null) {
    const claimed = await claimDeletionExecutionLease(
      database,
      deletionId,
      request.idempotency_key,
      executionOwnerToken,
      executionLeaseExpiresAt,
      observedAt,
    );
    if (!claimed) {
      return waitForDeletionResponse(database, deletionId, request.idempotency_key);
    }
  }
  const plan = await loadPlan(database, row.plan_id);
  if (plan === null) throw new Error("Deletion plan evidence is unavailable");
  await assertMaintenanceIdle(database, plan.expected_current_revision_id, observedAt);
  if (replay === null) {
    try {
      await database.batch([
        database
          .prepare(
            `INSERT INTO catalogue_export_deletion_retries (
             idempotency_key, deletion_id, object_set_digest,
             request_json, response_json, created_at
           ) VALUES (?, ?, ?, ?, NULL, ?)`,
          )
          .bind(request.idempotency_key, deletionId, request.object_set_digest, requestJson, observedAt),
        database
          .prepare(
            `UPDATE catalogue_export_deletions
           SET state = 'deleting', failure_code = NULL,
               retry_owner_idempotency_key = ?, execution_owner_token = ?,
               execution_lease_expires_at = ?
           WHERE id = ? AND state = 'failed'`,
          )
          .bind(request.idempotency_key, executionOwnerToken, executionLeaseExpiresAt, deletionId),
        database
          .prepare(
            `SELECT CASE WHEN EXISTS (
             SELECT 1 FROM catalogue_export_deletions
             WHERE id = ? AND state = 'deleting'
               AND retry_owner_idempotency_key = ?
               AND execution_owner_token = ?
           ) THEN 1 ELSE json_extract('invalid', '$') END`,
          )
          .bind(deletionId, request.idempotency_key, executionOwnerToken),
      ]);
    } catch {
      const concurrent = await database
        .prepare(
          `SELECT request_json, response_json
         FROM catalogue_export_deletion_retries WHERE idempotency_key = ?`,
        )
        .bind(request.idempotency_key)
        .first<{
          request_json: string;
          response_json: string | null;
        }>();
      if (concurrent !== null && concurrent.request_json === requestJson) {
        if (concurrent.response_json !== null) {
          return JSON.parse(concurrent.response_json) as Record<string, unknown>;
        }
        return waitForDeletionResponse(database, deletionId, request.idempotency_key);
      }
      throw problem(409, "export_deletion_not_failed", "Another retry claimed the failed deletion.");
    }
  }
  const manifestKey = await database
    .prepare("SELECT manifest_key FROM catalogue_exports WHERE catalogue_revision_id = ?")
    .bind(plan.catalogue_revision_id)
    .first<string>("manifest_key");
  if (manifestKey === null) throw new Error("Catalogue Export evidence is unavailable");
  const document = await executeDeletion(
    database,
    bucket,
    deletionId,
    plan,
    manifestKey,
    observedAt,
    request.idempotency_key,
    executionOwnerToken,
  );
  return document;
}

async function persistRetryResponse(
  database: D1Database,
  idempotencyKey: string,
  document: Record<string, unknown>,
): Promise<void> {
  await database
    .prepare(
      `UPDATE catalogue_export_deletion_retries SET response_json = ?
     WHERE idempotency_key = ? AND response_json IS NULL`,
    )
    .bind(canonicalJson(document), idempotencyKey)
    .run();
}

async function executeDeletion(
  database: D1Database,
  bucket: R2Bucket,
  deletionId: string,
  plan: PlanRow,
  manifestKey: string,
  observedAt: string,
  retryIdempotencyKey: string | null,
  executionOwnerToken: string,
): Promise<Record<string, unknown>> {
  const operation = await database
    .prepare("SELECT * FROM catalogue_export_deletions WHERE id = ?")
    .bind(deletionId)
    .first<DeletionRow>();
  if (operation === null) {
    throw new Error("Catalogue Export deletion evidence is unavailable");
  }
  const objectKeys = parseStringArray(plan.object_keys_json);
  const ordered = [...objectKeys.filter((key) => key !== manifestKey), manifestKey];
  const executionNow = advancingExecutionClock(observedAt);
  const renewLease = async (): Promise<string | null> => {
    const renewedAt = executionNow();
    return (await renewDeletionExecutionLease(
      database,
      deletionId,
      retryIdempotencyKey,
      executionOwnerToken,
      renewedAt,
    ))
      ? renewedAt
      : null;
  };
  const staleOwnerResponse = () => waitForDeletionResponse(database, deletionId, retryIdempotencyKey);
  try {
    for (const key of ordered) {
      if ((await renewLease()) === null) return staleOwnerResponse();
      if ((await bucket.head(key)) !== null) {
        if ((await renewLease()) === null) return staleOwnerResponse();
        await bucket.delete(key);
      }
    }
    const remaining: (R2Object | null)[] = [];
    for (const key of objectKeys) {
      if ((await renewLease()) === null) return staleOwnerResponse();
      remaining.push(await bucket.head(key));
    }
    const remainingPrefix = await listObjectKeys(
      bucket,
      `catalogue-exports/${plan.catalogue_revision_id}/`,
      async () => {
        if ((await renewLease()) === null) {
          throw new DeletionExecutionLeaseLost();
        }
      },
    );
    if (remaining.some((object) => object !== null) || remainingPrefix.length !== 0) {
      throw new Error("A bound Catalogue Export object remains present.");
    }
    const terminalLeaseObservedAt = await renewLease();
    if (terminalLeaseObservedAt === null) return staleOwnerResponse();
    const snapshot = deletionDocument({
      ...operation,
      state: "deleted",
      completed_at: observedAt,
      failure_code: null,
    });
    const responseJson = canonicalJson(snapshot);
    await database.batch([
      deletionExecutionOwnerAssertion(
        database,
        deletionId,
        retryIdempotencyKey,
        executionOwnerToken,
        terminalLeaseObservedAt,
      ),
      database
        .prepare(
          `UPDATE catalogue_export_deletions
         SET state = 'deleted', completed_at = ?, failure_code = NULL,
             confirmation_response_json = COALESCE(confirmation_response_json, ?)
         WHERE id = ? AND state = 'deleting'
           AND retry_owner_idempotency_key IS ?
           AND execution_owner_token = ?`,
        )
        .bind(observedAt, responseJson, deletionId, retryIdempotencyKey, executionOwnerToken),
      database
        .prepare(
          `UPDATE catalogue_exports
         SET maintenance_state = 'deleted', deleted_at = ?
         WHERE catalogue_revision_id = ? AND maintenance_state = 'deleting'
           AND deletion_operation_id = ?`,
        )
        .bind(observedAt, plan.catalogue_revision_id, deletionId),
      database
        .prepare(
          `INSERT INTO catalogue_export_deletion_tombstones (
           catalogue_revision_id, deletion_id, manifest_digest,
           object_set_digest, deleted_at
         ) VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(plan.catalogue_revision_id, deletionId, plan.manifest_digest, plan.object_set_digest, observedAt),
      ...(retryIdempotencyKey === null
        ? []
        : [
            database
              .prepare(
                `UPDATE catalogue_export_deletion_retries SET response_json = ?
           WHERE idempotency_key = ? AND response_json IS NULL`,
              )
              .bind(responseJson, retryIdempotencyKey),
          ]),
    ]);
  } catch (error) {
    if (error instanceof DeletionExecutionLeaseLost) {
      return staleOwnerResponse();
    }
    const terminalLeaseObservedAt = await renewLease();
    if (terminalLeaseObservedAt === null) return staleOwnerResponse();
    const snapshot = deletionDocument({
      ...operation,
      state: "failed",
      completed_at: null,
      failure_code: "deleted_object_set_mismatch",
    });
    const responseJson = canonicalJson(snapshot);
    await database
      .batch([
        deletionExecutionOwnerAssertion(
          database,
          deletionId,
          retryIdempotencyKey,
          executionOwnerToken,
          terminalLeaseObservedAt,
        ),
        database
          .prepare(
            `UPDATE catalogue_export_deletions
         SET state = 'failed', failure_code = 'deleted_object_set_mismatch',
             confirmation_response_json = COALESCE(confirmation_response_json, ?)
         WHERE id = ? AND state = 'deleting'
           AND retry_owner_idempotency_key IS ?
           AND execution_owner_token = ?`,
          )
          .bind(responseJson, deletionId, retryIdempotencyKey, executionOwnerToken),
        ...(retryIdempotencyKey === null
          ? []
          : [
              database
                .prepare(
                  `UPDATE catalogue_export_deletion_retries SET response_json = ?
           WHERE idempotency_key = ? AND response_json IS NULL`,
                )
                .bind(responseJson, retryIdempotencyKey),
            ]),
      ])
      .catch(async (terminalError: unknown) => {
        const reconciled = await loadDeletionResponse(database, deletionId, retryIdempotencyKey);
        if (reconciled !== null) return;
        throw terminalError ?? error;
      });
  }
  const response = await loadDeletionResponse(database, deletionId, retryIdempotencyKey);
  return response ?? catalogueExportDeletionStatus(database, deletionId);
}

function deletionExecutionOwnerAssertion(
  database: D1Database,
  deletionId: string,
  retryIdempotencyKey: string | null,
  executionOwnerToken: string,
  leaseObservedAt?: string,
): D1PreparedStatement {
  return database
    .prepare(
      `SELECT CASE WHEN EXISTS (
       SELECT 1 FROM catalogue_export_deletions
       WHERE id = ? AND state = 'deleting'
         AND retry_owner_idempotency_key IS ?
         AND execution_owner_token = ?
         ${leaseObservedAt === undefined ? "" : "AND execution_lease_expires_at > ?"}
     ) THEN 1 ELSE json_extract('invalid', '$') END`,
    )
    .bind(
      deletionId,
      retryIdempotencyKey,
      executionOwnerToken,
      ...(leaseObservedAt === undefined ? [] : [leaseObservedAt]),
    );
}

class DeletionExecutionLeaseLost extends Error {}

function advancingExecutionClock(observedAt: string): () => string {
  const executionStartedAt = Date.now();
  const observedAtMilliseconds = new Date(observedAt).valueOf();
  return () => new Date(observedAtMilliseconds + Date.now() - executionStartedAt).toISOString();
}

function leaseExpiresAt(observedAt: string): string {
  return new Date(new Date(observedAt).valueOf() + EXECUTION_LEASE_MS).toISOString();
}

async function claimDeletionExecutionLease(
  database: D1Database,
  deletionId: string,
  retryIdempotencyKey: string | null,
  executionOwnerToken: string,
  executionLeaseExpiresAt: string,
  observedAt: string,
): Promise<boolean> {
  try {
    await database.batch([
      database
        .prepare(
          `UPDATE catalogue_export_deletions
         SET execution_owner_token = ?, execution_lease_expires_at = ?
         WHERE id = ? AND state = 'deleting'
           AND retry_owner_idempotency_key IS ?
           AND (execution_owner_token IS NULL
             OR execution_lease_expires_at <= ?)`,
        )
        .bind(executionOwnerToken, executionLeaseExpiresAt, deletionId, retryIdempotencyKey, observedAt),
      deletionExecutionOwnerAssertion(database, deletionId, retryIdempotencyKey, executionOwnerToken),
    ]);
    return true;
  } catch {
    return false;
  }
}

async function renewDeletionExecutionLease(
  database: D1Database,
  deletionId: string,
  retryIdempotencyKey: string | null,
  executionOwnerToken: string,
  observedAt: string,
): Promise<boolean> {
  const renewedLeaseExpiresAt = leaseExpiresAt(observedAt);
  try {
    await database.batch([
      database
        .prepare(
          `UPDATE catalogue_export_deletions
         SET execution_lease_expires_at = ?
         WHERE id = ? AND state = 'deleting'
           AND retry_owner_idempotency_key IS ?
           AND execution_owner_token = ?
           AND execution_lease_expires_at > ?`,
        )
        .bind(renewedLeaseExpiresAt, deletionId, retryIdempotencyKey, executionOwnerToken, observedAt),
      database
        .prepare(
          `SELECT CASE WHEN EXISTS (
           SELECT 1 FROM catalogue_export_deletions
           WHERE id = ? AND state = 'deleting'
             AND retry_owner_idempotency_key IS ?
             AND execution_owner_token = ?
             AND execution_lease_expires_at = ?
         ) THEN 1 ELSE json_extract('invalid', '$') END`,
        )
        .bind(deletionId, retryIdempotencyKey, executionOwnerToken, renewedLeaseExpiresAt),
    ]);
    return true;
  } catch {
    return false;
  }
}

async function waitForDeletionResponse(
  database: D1Database,
  deletionId: string,
  retryIdempotencyKey: string | null,
): Promise<Record<string, unknown>> {
  let waitMilliseconds = REPLAY_WAIT_INITIAL_MS;
  for (let queryAttempt = 0; queryAttempt < REPLAY_RESPONSE_QUERY_BUDGET - 1; queryAttempt += 1) {
    const response = await loadDeletionResponse(database, deletionId, retryIdempotencyKey);
    if (response !== null) return response;
    if (queryAttempt + 1 < REPLAY_RESPONSE_QUERY_BUDGET - 1) {
      await new Promise((resolve) => setTimeout(resolve, waitMilliseconds));
      waitMilliseconds = Math.min(waitMilliseconds * 2, REPLAY_WAIT_MAX_MS);
    }
  }
  const operation = await database
    .prepare("SELECT * FROM catalogue_export_deletions WHERE id = ?")
    .bind(deletionId)
    .first<DeletionRow>();
  if (operation === null) {
    throw new Error("Catalogue Export deletion evidence is unavailable");
  }
  const acceptedResponseJson = canonicalJson(deletionDocument(operation));
  if (retryIdempotencyKey === null) {
    await database
      .prepare(
        `UPDATE catalogue_export_deletions
       SET confirmation_response_json = ?
       WHERE id = ? AND state = 'deleting'
         AND confirmation_response_json IS NULL`,
      )
      .bind(acceptedResponseJson, deletionId)
      .run();
  } else {
    await database
      .prepare(
        `UPDATE catalogue_export_deletion_retries SET response_json = ?
       WHERE idempotency_key = ? AND deletion_id = ?
         AND response_json IS NULL`,
      )
      .bind(acceptedResponseJson, retryIdempotencyKey, deletionId)
      .run();
  }
  const retained = await loadDeletionResponse(database, deletionId, retryIdempotencyKey);
  if (retained === null) {
    throw new Error("Catalogue Export deletion response evidence is unavailable");
  }
  return retained;
}

async function loadDeletionResponse(
  database: D1Database,
  deletionId: string,
  retryIdempotencyKey: string | null,
): Promise<Record<string, unknown> | null> {
  const responseJson =
    retryIdempotencyKey === null
      ? await database
          .prepare("SELECT confirmation_response_json FROM catalogue_export_deletions WHERE id = ?")
          .bind(deletionId)
          .first<string>("confirmation_response_json")
      : await database
          .prepare(
            "SELECT response_json FROM catalogue_export_deletion_retries WHERE idempotency_key = ? AND deletion_id = ?",
          )
          .bind(retryIdempotencyKey, deletionId)
          .first<string>("response_json");
  return responseJson === null ? null : (JSON.parse(responseJson) as Record<string, unknown>);
}

async function assertMutationGuards(
  database: D1Database,
  plan: PlanRow,
  confirmationRevisionId: string,
  observedAt: string,
): Promise<void> {
  if (confirmationRevisionId !== plan.catalogue_revision_id) {
    throw problem(409, "confirmation_required", "Type the exact Catalogue Revision identity.");
  }
  if (plan.catalogue_revision_id === plan.expected_current_revision_id) {
    throw problem(
      409,
      "current_export_required",
      "Publish or recover another Catalogue Revision before deleting this export.",
    );
  }
  await assertMaintenanceIdle(database, plan.expected_current_revision_id, observedAt);
}

async function assertMaintenanceIdle(
  database: D1Database,
  expectedCurrentRevisionId: string,
  observedAt: string,
): Promise<void> {
  const state = await database
    .prepare(
      `SELECT catalogue.current_revision_id, operation.active_ingestion_run_id,
            operation.active_release_id AS active_production_release_id,
            operation.active_release_expires_at AS active_production_release_expires_at,
            operation.recovery_health
     FROM catalogue_state AS catalogue
     JOIN operation_state AS operation ON operation.singleton = catalogue.singleton
     WHERE catalogue.singleton = 1`,
    )
    .first<OperationState>();
  if (state === null || state.current_revision_id !== expectedCurrentRevisionId) {
    throw problem(409, "current_revision_mismatch", "The expected current Catalogue Revision has changed.");
  }
  const productionReleaseActive =
    state.active_production_release_id !== null &&
    state.active_production_release_expires_at !== null &&
    state.active_production_release_expires_at > observedAt;
  if (state.active_ingestion_run_id !== null || productionReleaseActive || state.recovery_health !== "healthy") {
    throw problem(409, "maintenance_not_idle", "Ingestion and release must be idle and recovery must be healthy.");
  }
}

async function currentRevision(database: D1Database): Promise<string> {
  const revisionId = await database
    .prepare("SELECT current_revision_id FROM catalogue_state WHERE singleton = 1")
    .first<string>("current_revision_id");
  if (revisionId === null) throw new Error("Catalogue state is unavailable");
  return revisionId;
}

async function listObjectKeys(bucket: R2Bucket, prefix: string, beforeList?: () => Promise<void>): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    await beforeList?.();
    const page = await bucket.list({ prefix, ...(cursor === undefined ? {} : { cursor }) });
    keys.push(...page.objects.map(({ key }) => key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return keys.sort(compareUtf8);
}

async function verifiedExportObjects(
  bucket: R2Bucket,
  catalogueExport: ExportRow,
  prefix: string,
): Promise<{ objectKeys: string[]; componentNames: string[] }> {
  const manifestObject = await bucket.get(catalogueExport.manifest_key);
  if (manifestObject === null || manifestObject.size > 1_048_576) {
    throw problem(409, "unsafe_export_object_scope", "The verified manifest is unavailable.");
  }
  let manifest: {
    catalogue_revision?: { id?: unknown };
    manifest_sha256?: unknown;
    components?: unknown;
  };
  let text: string;
  try {
    text = await manifestObject.text();
    manifest = JSON.parse(text) as typeof manifest;
  } catch {
    throw problem(409, "unsafe_export_object_scope", "The verified manifest is invalid.");
  }
  const components = manifest.components;
  if (
    manifest.catalogue_revision?.id !== catalogueExport.catalogue_revision_id ||
    manifest.manifest_sha256 !== catalogueExport.manifest_digest ||
    !Array.isArray(components) ||
    components.some(
      (component) =>
        component === null ||
        typeof component !== "object" ||
        typeof (component as { name?: unknown }).name !== "string" ||
        typeof (component as { compressed_sha256?: unknown }).compressed_sha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test((component as { compressed_sha256: string }).compressed_sha256),
    )
  ) {
    throw problem(409, "unsafe_export_object_scope", "The verified manifest does not bind a safe component set.");
  }
  const selfDigest = await sha256Text(
    `${canonicalJson({
      ...manifest,
      manifest_sha256: "0".repeat(64),
    })}\n`,
  );
  if (text !== `${canonicalJson(manifest)}\n` || selfDigest !== catalogueExport.manifest_digest) {
    throw problem(409, "manifest_digest_mismatch", "The retained manifest bytes do not match their digest.");
  }
  const expected = [
    ...new Set([
      ...components.map(
        (component) =>
          `${prefix}components/${(component as { compressed_sha256: string }).compressed_sha256}.ndjson.gz`,
      ),
      catalogueExport.manifest_key,
    ]),
  ].sort(compareUtf8);
  const actual = await listObjectKeys(bucket, prefix);
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index]) ||
    expected.some((key) => !key.startsWith(prefix))
  ) {
    throw problem(
      409,
      "unsafe_export_object_scope",
      "The exact prefix contains objects outside the verified manifest.",
    );
  }
  return {
    objectKeys: expected,
    componentNames: components.map((component) => (component as { name: string }).name).sort(compareUtf8),
  };
}

async function loadPlan(database: D1Database, planId: string): Promise<PlanRow | null> {
  return database.prepare("SELECT * FROM catalogue_export_deletion_plans WHERE id = ?").bind(planId).first<PlanRow>();
}

function deletionDocument(row: DeletionRow): Record<string, unknown> {
  return {
    contract: "card-keepr-catalogue-export-deletion@1",
    id: row.id,
    plan_id: row.plan_id,
    state: row.state,
    catalogue_revision_id: row.catalogue_revision_id,
    manifest_digest: row.manifest_digest,
    expected_current_revision_id: row.expected_current_revision_id,
    object_set_digest: row.object_set_digest,
    idempotency_key: row.idempotency_key,
    requested_at: row.requested_at,
    completed_at: row.completed_at,
    failure_code: row.failure_code,
  };
}

function parseStringArray(json: string): string[] {
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("Persisted Catalogue Export object set is invalid");
  }
  return value;
}

function problem(status: 404 | 409 | 422, code: string, detail: string): CatalogueExportDeletionProblem {
  return new CatalogueExportDeletionProblem(status, code, detail);
}
