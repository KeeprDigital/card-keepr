import { AdministrationProblem } from "./administration-problem.mjs";
import {
  prepareCardSearchForD1ExportStatements,
  reconstructCardSearchAfterD1RestoreStatements,
} from "./card-search-recovery-statements.mjs";
import {
  withCardSearchPreparedForD1Export,
} from "./card-search-recovery";
import { cardCollectionPageQuery } from "./card-collection-read";
import { canonicalJson } from "./serialization";
import { StreamingSha256 } from "./streaming-sha256";

export type D1BackupProvider = Readonly<{
  exportSql(input: Readonly<{
    accountId: string;
    databaseId: string;
    token: string;
  }>): Promise<{
    body: ReadableStream<Uint8Array>;
    size: number;
    bookmark: string;
    filename: string;
  }>;
  prepareRestoreTarget(input: Readonly<{
    accountId: string;
    configuredDatabaseId: string;
    token: string;
    attemptId: string;
    previousDatabaseId: string | null;
    generation: number;
  }>): Promise<{ databaseId: string }>;
  restoreSql(input: Readonly<{
    accountId: string;
    databaseId: string;
    token: string;
    body: ReadableStream<Uint8Array>;
    size: number;
    etag: string;
  }>): Promise<void>;
  reconstructAndVerify(input: Readonly<{
    accountId: string;
    databaseId: string;
    token: string;
    ownerToken: string;
    expectedRevisionId: string;
    expectedSchemaMigrationLevel: number;
    expected: CatalogueVerificationEvidence;
  }>): Promise<RestoredCatalogueVerification>;
}>;

export type CatalogueVerificationEvidence = Readonly<{
  cards: number;
  printings: number;
  products: number;
  legality_rules: number;
  api_documents: number;
  search_terms: number;
  search_chunks: number;
  provenance: number;
  audit_rows: number;
  representative_card_id: string | null;
  representative_printing_id: string | null;
  representative_product_id: string | null;
  representative_legality_rule_id: string | null;
  representative_search_text: string | null;
  representative_curated_revision_id: string | null;
  representative_curated_revision_digest: string | null;
  publication_ingestion_run_id: string | null;
}>;

export type RestoredCatalogueVerification = Readonly<{
  schema: true;
  integrity: true;
  current_revision: true;
  representative_entities: true;
  search: true;
  provenance: true;
  audit: true;
  api: true;
}>;

type BackupInput = Readonly<{
  expectedCurrentRevisionId: string;
  idempotencyKey: string;
  observedAt: string;
  cloudflareAccountId: string;
  catalogueDatabaseId: string;
  disposableDatabaseId: string;
  exportToken: string;
  verificationToken: string;
  failedAttemptId?: string;
  failedAttemptDigest?: string;
}>;

type BackupExecutionOptions = Readonly<{
  terminalFailure?: boolean;
}>;

export type PublicationBackupReservation = Readonly<{
  idempotencyKey: string;
  requestJson: string;
  ownerToken: string;
  objectKey: string;
}>;

export async function publicationBackupReservation(
  catalogueRevisionId: string,
): Promise<PublicationBackupReservation> {
  const idempotencyKey = `publication-backup-${await sha256(catalogueRevisionId)}`;
  const digest = await sha256(idempotencyKey);
  return {
    idempotencyKey,
    requestJson: JSON.stringify({
      expected_current_revision_id: catalogueRevisionId,
    }),
    ownerToken: `backup:${digest}`,
    objectKey: `d1-backups/${catalogueRevisionId}/${digest}/catalogue.sql`,
  };
}

export type CatalogueBackupDocument = Readonly<{
  contract: "card-keepr-catalogue-backup@1";
  catalogue_revision_id: string;
  object_key: string;
  d1_bookmark: string;
  content_sha256: string;
  manifest_key: string;
  manifest_sha256: string;
  linked_attempt_id: string | null;
  retention: Readonly<{
    newest_success: boolean;
    retain_until: string | null;
  }>;
  verified: true;
}>;

type BackupAttemptEvidenceRow = Readonly<{
  idempotency_key: string;
  request_json: string;
  catalogue_revision_id: string;
  state: string;
  object_key: string;
  d1_bookmark: string | null;
  content_sha256: string | null;
  export_bytes: number | null;
  failure_code: string | null;
  failure_detail: string | null;
  started_at: string;
  completed_at: string | null;
  linked_attempt_id: string | null;
  manifest_sha256: string | null;
  disposable_database_id: string | null;
  restore_generation: number;
  restore_phase: string | null;
}>;

export async function catalogueBackupAttemptStatus(
  database: D1Database,
  idempotencyKey: string,
): Promise<Record<string, unknown>> {
  const attempt = await backupAttemptEvidenceRow(database, idempotencyKey);
  if (attempt === null) {
    throw new AdministrationProblem(404, "backup_not_found", "Backup attempt not found.");
  }
  const workflow = await database.prepare(
    `SELECT workflow_instance_id FROM catalogue_backup_workflow_requests
     WHERE idempotency_key = ?`,
  ).bind(idempotencyKey).first<{ workflow_instance_id: string }>();
  const digest = await backupAttemptDigest(attempt);
  return {
    contract: "card-keepr-catalogue-backup-status@1",
    idempotency_key: attempt.idempotency_key,
    catalogue_revision_id: attempt.catalogue_revision_id,
    state: attempt.state,
    attempt_digest: digest,
    object_key: attempt.object_key,
    content_sha256: attempt.content_sha256,
    manifest_sha256: attempt.manifest_sha256,
    linked_attempt_id: attempt.linked_attempt_id,
    disposable_database_id: attempt.disposable_database_id,
    restore_generation: attempt.restore_generation,
    restore_phase: attempt.restore_phase,
    failure: attempt.state === "failed"
      ? { code: attempt.failure_code, detail: attempt.failure_detail }
      : null,
    workflow_instance_id: workflow?.workflow_instance_id ?? null,
    resume: attempt.state === "pending" || isActiveAttemptState(attempt.state)
      ? {
        method: "POST",
        path: "/v1/backups",
        body: {
          ...JSON.parse(attempt.request_json) as Record<string, unknown>,
          idempotency_key: attempt.idempotency_key,
        },
      }
      : null,
    retry: attempt.state === "failed"
      ? {
        failed_attempt_id: attempt.idempotency_key,
        failed_attempt_digest: digest,
      }
      : null,
  };
}

export async function catalogueRevisionBackupStatus(
  database: D1Database,
  catalogueRevisionId: string,
): Promise<Record<string, unknown>> {
  const known = await database.prepare(
    `SELECT 1 AS present FROM catalogue_state
     WHERE singleton = 1 AND current_revision_id = ?
     UNION ALL
     SELECT 1 AS present FROM catalogue_revisions WHERE id = ?
     LIMIT 1`,
  ).bind(catalogueRevisionId, catalogueRevisionId).first<{ present: number }>();
  if (known === null) {
    throw new AdministrationProblem(
      404,
      "catalogue_revision_not_found",
      "Catalogue Revision not found.",
    );
  }
  const rows = await database.prepare(
    `SELECT idempotency_key FROM catalogue_backup_attempts
     WHERE catalogue_revision_id = ?
     ORDER BY started_at DESC, idempotency_key DESC`,
  ).bind(catalogueRevisionId).all<{ idempotency_key: string }>();
  return {
    contract: "card-keepr-catalogue-revision-backups@1",
    catalogue_revision_id: catalogueRevisionId,
    attempts: await Promise.all(rows.results.map((row) =>
      catalogueBackupAttemptStatus(database, row.idempotency_key)
    )),
  };
}

async function backupAttemptEvidenceRow(
  database: D1Database,
  idempotencyKey: string,
): Promise<BackupAttemptEvidenceRow | null> {
  return database.prepare(
    `SELECT idempotency_key, request_json, catalogue_revision_id, state,
            object_key, d1_bookmark, content_sha256, export_bytes,
            failure_code, failure_detail, started_at, completed_at,
            linked_attempt_id, manifest_sha256, disposable_database_id,
            restore_generation, restore_phase
     FROM catalogue_backup_attempts WHERE idempotency_key = ?`,
  ).bind(idempotencyKey).first<BackupAttemptEvidenceRow>();
}

async function backupAttemptDigest(row: BackupAttemptEvidenceRow): Promise<string> {
  return sha256(canonicalJson(row));
}

export async function validateCatalogueBackupRetryEvidence(
  database: D1Database,
  input: Readonly<{
    expectedCurrentRevisionId: string;
    idempotencyKey: string;
    failedAttemptId?: string;
    failedAttemptDigest?: string;
  }>,
): Promise<string | null> {
  if ((input.failedAttemptId === undefined) !==
    (input.failedAttemptDigest === undefined)) {
    throw new AdministrationProblem(
      422,
      "backup_retry_evidence_incomplete",
      "A backup retry requires both the exact failed attempt ID and digest.",
    );
  }
  if (input.failedAttemptId === undefined) {
    const retryRequired = await database.prepare(
      `SELECT 1 AS required
       FROM catalogue_backup_attempts AS failed
       WHERE failed.catalogue_revision_id = ?
         AND failed.state = 'failed'
         AND failed.idempotency_key <> ?
         AND NOT EXISTS (
           SELECT 1 FROM catalogue_backup_attempts AS recovered
           WHERE recovered.catalogue_revision_id = failed.catalogue_revision_id
             AND recovered.state = 'verified'
             AND recovered.completed_at >= failed.completed_at
         )
         AND NOT EXISTS (
           SELECT 1 FROM catalogue_backup_attempts AS reserved
           WHERE reserved.idempotency_key = ?
             AND reserved.publication_ingestion_run_id IS NOT NULL
         )
       LIMIT 1`,
    ).bind(
      input.expectedCurrentRevisionId,
      input.idempotencyKey,
      input.idempotencyKey,
    ).first<{ required: number }>();
    if (retryRequired !== null) {
      throw new AdministrationProblem(
        409,
        "backup_retry_required",
        "A failed backup for the current Catalogue Revision requires an exact linked retry.",
      );
    }
    return null;
  }
  const failed = await backupAttemptEvidenceRow(database, input.failedAttemptId);
  if (failed === null || failed.state !== "failed") {
    throw new AdministrationProblem(
      409,
      "source_backup_not_failed",
      "The source backup attempt is not failed.",
    );
  }
  const current = await database.prepare(
    "SELECT current_revision_id FROM catalogue_state WHERE singleton = 1",
  ).first<{ current_revision_id: string }>();
  if (
    failed.catalogue_revision_id !== current?.current_revision_id ||
    failed.catalogue_revision_id !== input.expectedCurrentRevisionId
  ) {
    throw new AdministrationProblem(
      409,
      "backup_not_current_revision",
      "The source backup does not belong to the current Catalogue Revision.",
    );
  }
  const child = await database.prepare(
    `SELECT idempotency_key FROM catalogue_backup_attempts
     WHERE linked_attempt_id = ?
     UNION ALL
     SELECT idempotency_key FROM catalogue_backup_workflow_requests
     WHERE linked_attempt_id = ?
     LIMIT 1`,
  ).bind(failed.idempotency_key, failed.idempotency_key).first<{
    idempotency_key: string;
  }>();
  if (child !== null && child.idempotency_key !== input.idempotencyKey) {
    throw backupRetrySourceSuperseded();
  }
  if (await backupAttemptDigest(failed) !== input.failedAttemptDigest) {
    throw new AdministrationProblem(
      409,
      "backup_digest_mismatch",
      "The failed backup attempt digest does not match retained evidence.",
    );
  }
  return failed.idempotency_key;
}

function backupRetrySourceSuperseded(): AdministrationProblem {
  return new AdministrationProblem(
    409,
    "backup_retry_source_superseded",
    "The failed backup attempt already has an immutable retry child.",
  );
}

export async function createVerifiedCatalogueBackup(
  database: D1Database,
  backups: R2Bucket,
  input: BackupInput,
  provider: D1BackupProvider = cloudflareD1BackupProvider,
  options: BackupExecutionOptions = {},
): Promise<CatalogueBackupDocument> {
  validateInput(input);
  const digest = await sha256(input.idempotencyKey);
  const ownerToken = `backup:${digest}`;
  const objectPrefix =
    `d1-backups/${input.expectedCurrentRevisionId}/${digest}`;
  const objectKey = `${objectPrefix}/catalogue.sql`;
  const manifestKey = `${objectPrefix}/manifest.json`;
  const requestJson = JSON.stringify({
    expected_current_revision_id: input.expectedCurrentRevisionId,
    ...(input.failedAttemptId === undefined
      ? {}
      : {
        failed_attempt_id: input.failedAttemptId,
        failed_attempt_digest: input.failedAttemptDigest,
      }),
  });
  const linkedAttemptId = await validateCatalogueBackupRetryEvidence(database, {
    expectedCurrentRevisionId: input.expectedCurrentRevisionId,
    idempotencyKey: input.idempotencyKey,
    failedAttemptId: input.failedAttemptId,
    failedAttemptDigest: input.failedAttemptDigest,
  });
  await database.prepare(
    `INSERT OR IGNORE INTO catalogue_backup_attempts (
       idempotency_key, request_json, owner_token, catalogue_revision_id,
       state, object_key, started_at, linked_attempt_id
     ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
  ).bind(
    input.idempotencyKey,
    requestJson,
    ownerToken,
    input.expectedCurrentRevisionId,
    objectKey,
    input.observedAt,
    linkedAttemptId,
  ).run();
  const attempt = await database.prepare(
    `SELECT request_json, state, catalogue_revision_id, object_key,
            d1_bookmark, failure_code, failure_detail, manifest_key,
            content_sha256, manifest_sha256, export_bytes,
            schema_migration_level, linked_attempt_id,
            publication_ingestion_run_id, disposable_database_id,
            restore_generation, restore_phase, retention.newest_success,
            retention.retain_until
     FROM catalogue_backup_attempts AS attempt
     LEFT JOIN catalogue_backup_retention AS retention
       ON retention.attempt_id = attempt.idempotency_key
     WHERE attempt.idempotency_key = ?`,
  ).bind(input.idempotencyKey).first<{
    request_json: string;
    state: string;
    catalogue_revision_id: string;
    object_key: string;
    d1_bookmark: string | null;
    failure_code: string | null;
    failure_detail: string | null;
    manifest_key: string | null;
    content_sha256: string | null;
    manifest_sha256: string | null;
    export_bytes: number | null;
    schema_migration_level: number | null;
    linked_attempt_id: string | null;
    publication_ingestion_run_id: string | null;
    disposable_database_id: string | null;
    restore_generation: number;
    restore_phase: string | null;
    newest_success: number | null;
    retain_until: string | null;
  }>();
  if (attempt === null && linkedAttemptId !== null) {
    const winningChild = await database.prepare(
      `SELECT idempotency_key FROM catalogue_backup_attempts
       WHERE linked_attempt_id = ? LIMIT 1`,
    ).bind(linkedAttemptId).first<{ idempotency_key: string }>();
    if (winningChild !== null) throw backupRetrySourceSuperseded();
  }
  if (attempt?.request_json !== requestJson) {
    throw new AdministrationProblem(
      409,
      "idempotency_key_reused",
      "The backup idempotency key is bound to another request.",
    );
  }
  if (
    attempt.state === "verified" && attempt.d1_bookmark !== null &&
    attempt.manifest_key !== null && attempt.content_sha256 !== null &&
    attempt.manifest_sha256 !== null
  ) {
    return backupDocument({
      catalogue_revision_id: attempt.catalogue_revision_id,
      object_key: attempt.object_key,
      d1_bookmark: attempt.d1_bookmark,
      content_sha256: attempt.content_sha256,
      manifest_key: attempt.manifest_key,
      manifest_sha256: attempt.manifest_sha256,
      linked_attempt_id: attempt.linked_attempt_id,
      newest_success: attempt.newest_success === 1,
      retain_until: attempt.retain_until,
    });
  }
  if (attempt.state === "failed") {
    throw new AdministrationProblem(
      409,
      attempt.failure_code ?? "backup_attempt_failed",
      attempt.failure_detail ?? "The retained backup attempt failed.",
    );
  }
  if (!isActiveAttemptState(attempt.state)) {
    throw new AdministrationProblem(
      409,
      "backup_in_progress",
      "The retained backup attempt is already in progress.",
    );
  }
  const publicationOwned = attempt.publication_ingestion_run_id !== null;
  const state = await database.prepare(
    `SELECT catalogue.current_revision_id,
            operation.active_ingestion_run_id,
            operation.recovery_health
     FROM catalogue_state AS catalogue
     JOIN operation_state AS operation ON operation.singleton = 1
     WHERE catalogue.singleton = 1`,
  ).first<{
    current_revision_id: string;
    active_ingestion_run_id: string | null;
    recovery_health: string;
  }>();
  if (state?.current_revision_id !== input.expectedCurrentRevisionId) {
    await failAttempt(
      database,
      input.idempotencyKey,
      ownerToken,
      input.observedAt,
      "current_revision_mismatch",
      "The expected current Catalogue Revision is stale.",
    );
    throw new AdministrationProblem(
      409,
      "current_revision_mismatch",
      "The expected current Catalogue Revision is stale.",
    );
  }
  if (state.active_ingestion_run_id !== null && !publicationOwned) {
    await failAttempt(
      database,
      input.idempotencyKey,
      ownerToken,
      input.observedAt,
      "maintenance_not_idle",
      "Catalogue backup requires idle ingestion.",
    );
    throw new AdministrationProblem(
      409,
      "maintenance_not_idle",
      "Catalogue backup requires idle ingestion.",
    );
  }
  const expectedVerification = await captureCatalogueVerificationEvidence(
    database,
    input.expectedCurrentRevisionId,
  );
  let attemptState = attempt.state;
  if (attemptState === "pending") {
    try {
      await database.batch([
        database.prepare(
          `SELECT CASE WHEN EXISTS (
             SELECT 1 FROM catalogue_backup_attempts AS attempt
             JOIN operation_state AS operation ON operation.singleton = 1
             WHERE attempt.idempotency_key = ? AND attempt.owner_token = ?
               AND attempt.state = 'pending'
               AND (? = 1 OR operation.active_ingestion_run_id IS NULL)
               AND operation.recovery_health <> 'blocked'
               AND NOT EXISTS (
                 SELECT 1 FROM catalogue_backup_attempts AS active
                 WHERE active.idempotency_key <> attempt.idempotency_key
                   AND active.state IN (
                     'exporting', 'restoring_verification', 'verifying'
                   )
               )
           ) THEN 1 ELSE json_extract('invalid', '$') END`,
        ).bind(input.idempotencyKey, ownerToken, publicationOwned ? 1 : 0),
        database.prepare(
          `UPDATE catalogue_backup_attempts SET state = 'exporting'
           WHERE idempotency_key = ? AND owner_token = ? AND state = 'pending'`,
        ).bind(input.idempotencyKey, ownerToken),
        database.prepare(
          `UPDATE operation_state
           SET recovery_health = CASE WHEN ? = 1 THEN 'degraded' ELSE 'blocked' END
           WHERE singleton = 1
             AND (? = 1 OR active_ingestion_run_id IS NULL)
             AND recovery_health <> 'blocked'`,
        ).bind(publicationOwned ? 1 : 0, publicationOwned ? 1 : 0),
      ]);
    } catch {
      throw new AdministrationProblem(
        409,
        "backup_in_progress",
        "Another Catalogue backup attempt is already in progress.",
      );
    }
    attemptState = "exporting";
  } else if (
    state.recovery_health !== (publicationOwned ? "degraded" : "blocked")
  ) {
    throw new Error("The active backup attempt lost its recovery block.");
  }

  const leaseObservedAt = new Date(Math.max(
    Date.now(),
    Date.parse(input.observedAt),
  )).toISOString();
  const leaseExpiresAt = new Date(
    Date.parse(leaseObservedAt) + 60 * 60 * 1000,
  ).toISOString();
  try {
    let bookmark = attempt.d1_bookmark;
    let exportBytes = attempt.export_bytes;
    let contentSha256 = attempt.content_sha256;
    let disposableDatabaseId = attempt.disposable_database_id;
    let restoreGeneration = attempt.restore_generation;
    const schemaMigrationLevel = attempt.schema_migration_level ??
      await currentSchemaMigrationLevel(database);
    if (attemptState === "exporting") {
      const existing = await backups.get(objectKey);
      let exportedBookmark: string;
      if (existing !== null) {
        exportedBookmark = existing.customMetadata?.d1_bookmark ?? "";
        if (
          existing.customMetadata?.catalogue_revision_id !==
            input.expectedCurrentRevisionId ||
          exportedBookmark.length === 0
        ) throw new Error("Retained backup object evidence does not match the attempt.");
        const retainedEvidence = await digestRetainedObject(existing);
        contentSha256 = retainedEvidence.sha256;
        exportBytes = retainedEvidence.size;
      } else {
        await database.prepare(
          `UPDATE operation_state SET recovery_restore_guard = 'blocked'
           WHERE singleton = 1 AND recovery_restore_guard = 'clear'`,
        ).run();
        let exported;
        try {
          exported = await withCardSearchPreparedForD1Export(
            database,
            { ownerToken, observedAt: leaseObservedAt, leaseExpiresAt },
            () => provider.exportSql({
              accountId: input.cloudflareAccountId,
              databaseId: input.catalogueDatabaseId,
              token: input.exportToken,
            }),
          );
        } finally {
          await database.prepare(
            `UPDATE operation_state SET recovery_restore_guard = 'clear'
             WHERE singleton = 1 AND recovery_restore_guard = 'blocked'
               AND active_recovery_id IS NULL`,
          ).run();
        }
        exportedBookmark = exported.bookmark;
        const sized = new FixedLengthStream(exported.size);
        const contentDigest = new StreamingSha256();
        const hashing = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            contentDigest.update(chunk);
            controller.enqueue(chunk);
          },
        });
        const [, retainedObject] = await Promise.all([
          exported.body.pipeThrough(hashing).pipeTo(sized.writable),
          backups.put(objectKey, sized.readable, {
            onlyIf: { etagDoesNotMatch: "*" },
            httpMetadata: { contentType: "application/sql; charset=utf-8" },
            customMetadata: {
              catalogue_revision_id: input.expectedCurrentRevisionId,
              d1_bookmark: exported.bookmark,
            },
          }),
        ]);
        if (retainedObject === null) {
          throw new Error("Immutable backup object already exists.");
        }
        const retained = await backups.head(objectKey);
        if (retained === null || retained.size !== exported.size) {
          throw new Error("Retained backup digest is unavailable.");
        }
        contentSha256 = contentDigest.digestHex();
        exportBytes = retained.size;
      }
      await transitionExportedAttempt(
        database,
        input.idempotencyKey,
        ownerToken,
        exportedBookmark,
        contentSha256,
        exportBytes,
        schemaMigrationLevel,
      );
      bookmark = exportedBookmark;
      attemptState = "restoring_verification";
    }
    if (bookmark === null) {
      throw new Error("The retained D1 export bookmark is unavailable.");
    }
    if (contentSha256 === null || exportBytes === null) {
      throw new Error("The retained D1 export evidence is unavailable.");
    }
    if (attemptState === "restoring_verification") {
      const nextGeneration = restoreGeneration + 1;
      const prepared = await provider.prepareRestoreTarget({
        accountId: input.cloudflareAccountId,
        configuredDatabaseId: input.disposableDatabaseId,
        token: input.verificationToken,
        attemptId: input.idempotencyKey,
        previousDatabaseId: disposableDatabaseId,
        generation: nextGeneration,
      });
      await persistPreparedRestoreTarget(
        database,
        input.idempotencyKey,
        ownerToken,
        prepared.databaseId,
        restoreGeneration,
        nextGeneration,
      );
      disposableDatabaseId = prepared.databaseId;
      restoreGeneration = nextGeneration;
      const stored = await backups.get(objectKey);
      if (stored === null) throw new Error("Retained backup is unavailable.");
      await transitionRestorePhase(
        database,
        input.idempotencyKey,
        ownerToken,
        "prepared",
        "importing",
      );
      await provider.restoreSql({
        accountId: input.cloudflareAccountId,
        databaseId: disposableDatabaseId,
        token: input.verificationToken,
        body: stored.body,
        size: stored.size,
        etag: stored.etag,
      });
      await transitionRestoredAttempt(
        database,
        input.idempotencyKey,
        ownerToken,
      );
      attemptState = "verifying";
    }
    if (attemptState === "verifying") {
      if (
        disposableDatabaseId === null || restoreGeneration < 1 ||
        (attempt.restore_phase !== "imported" &&
          attemptState === attempt.state)
      ) {
        throw new Error("The persisted disposable restore target is unavailable.");
      }
      const restoredVerification = await provider.reconstructAndVerify({
        accountId: input.cloudflareAccountId,
        databaseId: disposableDatabaseId,
        token: input.verificationToken,
        ownerToken,
        expectedRevisionId: input.expectedCurrentRevisionId,
        expectedSchemaMigrationLevel: schemaMigrationLevel,
        expected: expectedVerification,
      });
      assertCompleteRestoredVerification(restoredVerification);
    }
    const manifest = {
      contract: "card-keepr-catalogue-backup-manifest@1",
      attempt_id: input.idempotencyKey,
      catalogue_revision_id: input.expectedCurrentRevisionId,
      content_sha256: contentSha256,
      d1_bookmark: bookmark,
      export_bytes: exportBytes,
      exported_at: input.observedAt,
      object_key: objectKey,
      producing_workflow_identity: input.idempotencyKey,
      schema_migration_level: schemaMigrationLevel,
      expected_evidence: expectedVerification,
      verification: {
        disposable_database_id: disposableDatabaseId,
        restore_generation: restoreGeneration,
        verified: true,
        verified_at: input.observedAt,
      },
    } as const;
    const manifestJson = canonicalJson(manifest);
    const manifestSha256 = await sha256(manifestJson);
    const storedManifest = await backups.put(manifestKey, manifestJson, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      customMetadata: {
        catalogue_revision_id: input.expectedCurrentRevisionId,
        content_sha256: contentSha256,
        manifest_sha256: manifestSha256,
      },
    });
    if (storedManifest === null) {
      const existingManifest = await backups.head(manifestKey);
      if (
        existingManifest?.customMetadata?.manifest_sha256 !== manifestSha256
      ) throw new Error("Immutable backup manifest already exists.");
    }
    try {
      await database.batch([
        database.prepare(
          `SELECT CASE WHEN EXISTS (
             SELECT 1 FROM catalogue_backup_attempts
             WHERE idempotency_key = ? AND owner_token = ?
               AND state = 'verifying'
           ) THEN 1 ELSE json_extract('invalid', '$') END`,
        ).bind(input.idempotencyKey, ownerToken),
        database.prepare(
          `UPDATE catalogue_backup_attempts
           SET state = 'verified', d1_bookmark = ?, completed_at = ?,
               manifest_key = ?, manifest_sha256 = ?,
               restore_phase = 'verified'
           WHERE idempotency_key = ? AND owner_token = ?
             AND state = 'verifying'`,
        ).bind(
          bookmark,
          input.observedAt,
          manifestKey,
          manifestSha256,
          input.idempotencyKey,
          ownerToken,
        ),
        database.prepare(
          `UPDATE catalogue_backup_retention
           SET newest_success = 0,
               retain_until = (
                 SELECT strftime('%Y-%m-%dT%H:%M:%fZ', completed_at, '+90 days')
                 FROM catalogue_backup_attempts
                 WHERE idempotency_key = catalogue_backup_retention.attempt_id
               )
           WHERE newest_success = 1`,
        ),
        database.prepare(
          `INSERT INTO catalogue_backup_retention (
             attempt_id, newest_success, retain_until, policy
           ) VALUES (?, 1, NULL, 'newest-indefinite-and-dated-90-days')`,
        ).bind(input.idempotencyKey),
        database.prepare(
          `UPDATE operation_state SET recovery_health = 'healthy'
           WHERE singleton = 1
             AND recovery_health IN ('blocked', 'degraded')`,
        ),
      ]);
    } catch {
      throw new AdministrationProblem(
        409,
        "backup_in_progress",
        "The backup attempt state changed concurrently.",
      );
    }
    return backupDocument({
      catalogue_revision_id: input.expectedCurrentRevisionId,
      object_key: objectKey,
      d1_bookmark: bookmark,
      content_sha256: contentSha256,
      manifest_key: manifestKey,
      manifest_sha256: manifestSha256,
      linked_attempt_id: attempt.linked_attempt_id,
      newest_success: true,
      retain_until: null,
    });
  } catch (error) {
    if (options.terminalFailure !== false) {
      await failActiveCatalogueBackupAttempt(
        database,
        input.idempotencyKey,
        input.observedAt,
        error instanceof Error ? error.message : "Catalogue backup failed.",
      );
    }
    throw error;
  }
}

export async function verifyRestoredCatalogue(
  database: D1Database,
  input: Readonly<{
    expectedRevisionId: string;
    expectedSchemaMigrationLevel: number;
    expected: CatalogueVerificationEvidence;
  }>,
): Promise<RestoredCatalogueVerification> {
  return verifyRestoredCatalogueQueries(
    async (sql, params = []) => {
      const statement = database.prepare(sql);
      const result = await (params.length === 0
        ? statement
        : statement.bind(...params)).all<Record<string, unknown>>();
      return result.results;
    },
    input,
  );
}

export async function captureCatalogueVerificationEvidence(
  database: D1Database,
  revisionId: string,
): Promise<CatalogueVerificationEvidence> {
  const row = await database.prepare(verificationEvidenceSql()).bind(
    revisionId,
    "capture",
  ).first<CatalogueVerificationEvidence>();
  if (row === null) throw new Error("Catalogue verification evidence is unavailable.");
  return {
    cards: row.cards,
    printings: row.printings,
    products: row.products,
    legality_rules: row.legality_rules,
    api_documents: row.api_documents,
    search_terms: row.search_terms,
    search_chunks: row.search_chunks,
    provenance: row.provenance,
    audit_rows: row.audit_rows,
    representative_card_id: row.representative_card_id,
    representative_printing_id: row.representative_printing_id,
    representative_product_id: row.representative_product_id,
    representative_legality_rule_id: row.representative_legality_rule_id,
    representative_search_text: row.representative_search_text,
    representative_curated_revision_id: row.representative_curated_revision_id,
    representative_curated_revision_digest:
      row.representative_curated_revision_digest,
    publication_ingestion_run_id: row.publication_ingestion_run_id,
  };
}

type VerificationQuery = (
  sql: string,
  params?: readonly unknown[],
) => Promise<Record<string, unknown>[]>;

async function verifyRestoredCatalogueQueries(
  query: VerificationQuery,
  input: Readonly<{
    expectedRevisionId: string;
    expectedSchemaMigrationLevel: number;
    expected: CatalogueVerificationEvidence;
  }>,
): Promise<RestoredCatalogueVerification> {
  const [row] = await query(verificationEvidenceSql(), [
    input.expectedRevisionId,
    canonicalJson(input.expected),
  ]);
  const [integrity] = await query("PRAGMA quick_check");
  const expected = input.expected;
  const apiRows = expected.representative_search_text === null ||
      expected.representative_card_id === null
    ? []
    : await representativeCardApiRows(
      query,
      input.expectedRevisionId,
      expected.representative_card_id,
      expected.representative_search_text,
    );
  const exactEvidence = row !== undefined &&
    row.current_revision_id === input.expectedRevisionId &&
    row.schema_migration_level === input.expectedSchemaMigrationLevel &&
    row.card_search_state === "ready" &&
    row.card_search_fts_tables === 1 &&
    row.missing_fts_rows === 0 &&
    row.invalid_api_documents === 0 &&
    row.invalid_curated_provenance === 0 &&
    row.invalid_audit_rows === 0 &&
    row.cards === expected.cards &&
    row.printings === expected.printings &&
    row.products === expected.products &&
    row.legality_rules === expected.legality_rules &&
    row.api_documents === expected.api_documents &&
    row.search_terms === expected.search_terms &&
    row.search_chunks === expected.search_chunks &&
    row.provenance === expected.provenance &&
    row.audit_rows === expected.audit_rows &&
    row.representative_card_id === expected.representative_card_id &&
    row.representative_printing_id === expected.representative_printing_id &&
    row.representative_product_id === expected.representative_product_id &&
    row.representative_legality_rule_id ===
      expected.representative_legality_rule_id &&
    row.representative_curated_revision_id ===
      expected.representative_curated_revision_id &&
    row.representative_curated_revision_digest ===
      expected.representative_curated_revision_digest &&
    row.publication_ingestion_run_id ===
      expected.publication_ingestion_run_id;
  const nonVacuous = [
    expected.cards,
    expected.printings,
    expected.products,
    expected.legality_rules,
    expected.api_documents,
    expected.search_terms,
    expected.search_chunks,
    expected.audit_rows,
  ].every((count) => count > 0) &&
    [
      expected.representative_card_id,
      expected.representative_printing_id,
      expected.representative_product_id,
      expected.representative_legality_rule_id,
      expected.representative_search_text,
      expected.publication_ingestion_run_id,
    ].every((value) => typeof value === "string" && value.length > 0) &&
    (expected.provenance === 0
      ? expected.representative_curated_revision_id === null &&
        expected.representative_curated_revision_digest === null
      : typeof expected.representative_curated_revision_id === "string" &&
        typeof expected.representative_curated_revision_digest === "string");
  if (
    integrity?.quick_check !== "ok" || !exactEvidence || !nonVacuous ||
    apiRows.length === 0 || !apiRows.every(validApiCardRow) ||
    !apiRows.some((apiRow) =>
      apiCardId(apiRow) === expected.representative_card_id
    )
  ) throw new Error("Restored D1 verification failed.");
  return completeRestoredVerification();
}

async function representativeCardApiRows(
  query: VerificationQuery,
  revisionId: string,
  representativeCardId: string,
  searchText: string,
): Promise<Record<string, unknown>[]> {
  const page = cardCollectionPageQuery(revisionId, {
    q: searchText,
    game: null,
    cardNumber: null,
    limit: 100,
  }, null, 100);
  return query(
    `WITH expected_card(value) AS (SELECT ?),
          api_page AS (${page.sql})
     SELECT api_page.* FROM api_page, expected_card
     WHERE expected_card.value IS NOT NULL`,
    [representativeCardId, ...page.bindings],
  );
}

function verificationEvidenceSql(): string {
  return `SELECT catalogue.current_revision_id,
      schema_state.migration_level AS schema_migration_level,
      search.state AS card_search_state,
      (SELECT count(*) FROM sqlite_schema WHERE type = 'table'
       AND name = 'revision_card_search_fts'
       AND lower(sql) LIKE '%create virtual table%') AS card_search_fts_tables,
      (SELECT count(*) FROM revision_card_search_chunks AS chunk
       LEFT JOIN revision_card_search_fts_rows AS mapped USING (
         catalogue_revision_id, card_id, field_ordinal, chunk_ordinal
       ) WHERE chunk.catalogue_revision_id = catalogue.current_revision_id
         AND mapped.fts_rowid IS NULL) AS missing_fts_rows,
      (SELECT count(*) FROM revision_card_query_documents
       WHERE catalogue_revision_id = catalogue.current_revision_id
         AND json_valid(summary_json) = 0) AS invalid_api_documents,
      (SELECT count(*) FROM catalogue_curated_provenance AS provenance
       LEFT JOIN curated_revisions AS curated
         ON curated.id = provenance.curated_revision_id
       WHERE provenance.catalogue_revision_id = catalogue.current_revision_id
         AND (
           curated.id IS NULL
           OR provenance.content_digest <> curated.content_digest
           OR provenance.target_key <> curated.target_key
           OR json_valid(provenance.provenance_json) = 0
           OR json_extract(provenance.provenance_json, '$.author')
                IS NOT curated.author
           OR json_extract(provenance.provenance_json, '$.created_at')
                IS NOT curated.created_at
           OR json_type(provenance.provenance_json, '$.evidence') <> 'array'
           OR json_extract(provenance.provenance_json, '$.evidence')
                IS NOT json_extract(curated.proposal_json, '$.evidence')
           OR json_extract(provenance.provenance_json, '$.rationale')
                IS NOT json_extract(curated.proposal_json, '$.rationale')
         )) AS invalid_curated_provenance,
      (SELECT count(*) FROM catalogue_revisions AS revision
       JOIN ingestion_runs AS run ON run.id = revision.ingestion_run_id
       WHERE revision.id = catalogue.current_revision_id
         AND json_valid(run.progress_json) = 0) AS invalid_audit_rows,
      (SELECT count(*) FROM revision_cards
       WHERE catalogue_revision_id = catalogue.current_revision_id) AS cards,
      (SELECT count(*) FROM revision_printings
       WHERE catalogue_revision_id = catalogue.current_revision_id) AS printings,
      (SELECT count(*) FROM revision_products
       WHERE catalogue_revision_id = catalogue.current_revision_id) AS products,
      (SELECT count(*) FROM revision_legality_rules
       WHERE catalogue_revision_id = catalogue.current_revision_id) AS legality_rules,
      (SELECT count(*) FROM revision_card_query_documents
       WHERE catalogue_revision_id = catalogue.current_revision_id) AS api_documents,
      (SELECT count(*) FROM revision_card_search_terms
       WHERE catalogue_revision_id = catalogue.current_revision_id) AS search_terms,
      (SELECT count(*) FROM revision_card_search_chunks
       WHERE catalogue_revision_id = catalogue.current_revision_id) AS search_chunks,
      (SELECT count(*) FROM catalogue_curated_provenance
       WHERE catalogue_revision_id = catalogue.current_revision_id)
        AS provenance,
      (SELECT count(*) FROM catalogue_revisions AS revision
       JOIN ingestion_runs AS run ON run.id = revision.ingestion_run_id
       WHERE revision.id = catalogue.current_revision_id) AS audit_rows,
      (SELECT card_id FROM revision_card_query_documents
       WHERE catalogue_revision_id = catalogue.current_revision_id
       ORDER BY sort_game, sort_identity_kind, sort_identity_value, sort_id
       LIMIT 1) AS representative_card_id,
      (SELECT printing_id FROM revision_printings
       WHERE catalogue_revision_id = catalogue.current_revision_id
       ORDER BY printing_id LIMIT 1) AS representative_printing_id,
      (SELECT product_id FROM revision_products
       WHERE catalogue_revision_id = catalogue.current_revision_id
       ORDER BY product_id LIMIT 1) AS representative_product_id,
      (SELECT legality_rule_id FROM revision_legality_rules
       WHERE catalogue_revision_id = catalogue.current_revision_id
       ORDER BY legality_rule_id LIMIT 1) AS representative_legality_rule_id,
      (SELECT sort_identity_value FROM revision_card_query_documents
       WHERE catalogue_revision_id = catalogue.current_revision_id
       ORDER BY sort_game, sort_identity_kind, sort_identity_value, sort_id
       LIMIT 1) AS representative_search_text,
      (SELECT curated_revision_id FROM catalogue_curated_provenance
       WHERE catalogue_revision_id = catalogue.current_revision_id
       ORDER BY curated_revision_id LIMIT 1)
        AS representative_curated_revision_id,
      (SELECT content_digest FROM catalogue_curated_provenance
       WHERE catalogue_revision_id = catalogue.current_revision_id
       ORDER BY curated_revision_id LIMIT 1)
        AS representative_curated_revision_digest,
      (SELECT ingestion_run_id FROM catalogue_revisions
       WHERE id = catalogue.current_revision_id) AS publication_ingestion_run_id
    FROM catalogue_state AS catalogue
    JOIN card_search_fts_state AS search ON search.singleton = 1
    JOIN catalogue_schema_state AS schema_state ON schema_state.singleton = 1
    WHERE catalogue.singleton = 1 AND catalogue.current_revision_id = ?
      AND ? IS NOT NULL`;
}

export const cloudflareD1BackupProvider: D1BackupProvider = {
  async exportSql(input) {
    const pathname = d1Path(input.accountId, input.databaseId, "export");
    let bookmark: string | undefined;
    for (let attempt = 0; attempt < 1_200; attempt += 1) {
      const result = await cloudflareD1Request(
        pathname,
        input.token,
        {
          output_format: "polling",
          ...(bookmark === undefined
            ? {}
            : { current_bookmark: bookmark }),
        },
      );
      if (result.status === "error") {
        throw new Error(`D1 export failed: ${String(result.error)}`);
      }
      if (result.status === "complete") {
        const signedUrl = objectString(result.result, "signed_url");
        const filename = objectString(result.result, "filename");
        const atBookmark = requiredString(result.at_bookmark, "bookmark");
        const downloaded = await fetch(signedUrl);
        if (!downloaded.ok) throw new Error("D1 export download failed.");
        if (downloaded.body === null) {
          throw new Error("D1 export body is unavailable.");
        }
        return {
          body: downloaded.body,
          size: requiredContentLength(downloaded),
          bookmark: atBookmark,
          filename,
        };
      }
      bookmark = requiredString(result.at_bookmark, "bookmark");
      await delay(500);
    }
    throw new Error("D1 export polling exceeded its bounded attempts.");
  },

  async prepareRestoreTarget(input) {
    const collectionPath =
      `/accounts/${encodeURIComponent(input.accountId)}/d1/database`;
    const listed = await cloudflareD1ManagementRequest(
      `${collectionPath}?name=${
        encodeURIComponent("card-keepr-disposable-verification")
      }`,
      input.token,
      "GET",
    );
    if (!Array.isArray(listed)) {
      throw new Error("Disposable D1 database inventory is invalid.");
    }
    const databaseIds = new Set<string>();
    for (const candidate of listed) {
      if (isRecord(candidate) && typeof candidate.uuid === "string") {
        databaseIds.add(candidate.uuid);
      }
    }
    if (input.previousDatabaseId !== null) {
      databaseIds.add(input.previousDatabaseId);
    }
    if (input.generation === 1) {
      databaseIds.add(input.configuredDatabaseId);
    }
    for (const databaseId of databaseIds) {
      await deleteCloudflareD1Database(
        input.accountId,
        databaseId,
        input.token,
      );
    }
    const created = await cloudflareD1ManagementRequest(
      collectionPath,
      input.token,
      "POST",
      { name: "card-keepr-disposable-verification" },
    );
    if (!isRecord(created)) {
      throw new Error("Disposable D1 database creation response is invalid.");
    }
    return { databaseId: requiredString(created.uuid, "database identity") };
  },

  async restoreSql(input) {
    const pathname = d1Path(input.accountId, input.databaseId, "import");
    const etag = input.etag.replaceAll('"', "");
    const initialized = await cloudflareD1Request(
      pathname,
      input.token,
      { action: "init", etag },
    );
    const uploadUrl = requiredString(initialized.upload_url, "upload URL");
    const filename = requiredString(initialized.filename, "filename");
    const uploaded = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "content-length": String(input.size) },
      body: input.body,
    });
    if (
      !uploaded.ok ||
      uploaded.headers.get("etag")?.replaceAll('"', "") !== etag
    ) {
      throw new Error("D1 restore upload failed.");
    }
    let result = await cloudflareD1Request(
      pathname,
      input.token,
      { action: "ingest", etag, filename },
    );
    for (let attempt = 0; attempt < 1_200; attempt += 1) {
      if (result.status === "error") {
        throw new Error(`D1 restore failed: ${String(result.error)}`);
      }
      if (result.status === "complete") return;
      result = await cloudflareD1Request(
        pathname,
        input.token,
        {
          action: "poll",
          current_bookmark: requiredString(
            result.at_bookmark,
            "bookmark",
          ),
        },
      );
      await delay(500);
    }
    throw new Error("D1 restore polling exceeded its bounded attempts.");
  },

  async reconstructAndVerify(input) {
    const pathname = d1Path(input.accountId, input.databaseId, "query");
    for (const sql of prepareCardSearchForD1ExportStatements) {
      await cloudflareD1Request(pathname, input.token, { sql });
    }
    for (const sql of reconstructCardSearchAfterD1RestoreStatements) {
      await cloudflareD1Request(pathname, input.token, { sql });
    }
    await cloudflareD1Request(pathname, input.token, {
      sql:
        `UPDATE card_search_fts_state
         SET state = 'ready', owner_token = NULL, lease_expires_at = NULL
         WHERE singleton = 1 AND state = 'reconstructing'
           AND owner_token = ?`,
      params: [input.ownerToken],
    });
    return verifyRestoredCatalogueQueries(
      async (sql, params = []) => queryRows(await cloudflareD1Request(
        pathname,
        input.token,
        { sql, params },
      )),
      input,
    );
  },
};

async function cloudflareD1ManagementRequest(
  pathname: string,
  token: string,
  method: "GET" | "POST",
  body?: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4${pathname}`,
    {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  const envelope = await response.json<{
    success?: boolean;
    result?: unknown;
  }>();
  if (!response.ok || envelope.success !== true) {
    throw new Error("Cloudflare D1 management operation failed.");
  }
  return envelope.result;
}

async function deleteCloudflareD1Database(
  accountId: string,
  databaseId: string,
  token: string,
): Promise<void> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${
      encodeURIComponent(accountId)
    }/d1/database/${encodeURIComponent(databaseId)}`,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    },
  );
  if (response.status === 404) return;
  const envelope = await response.json<{ success?: boolean }>();
  if (!response.ok || envelope.success !== true) {
    throw new Error("Disposable D1 database deletion failed.");
  }
}

async function cloudflareD1Request(
  pathname: string,
  token: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4${pathname}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  const envelope = await response.json<{
    success?: boolean;
    result?: Record<string, unknown>;
  }>();
  if (!response.ok || envelope.success !== true || envelope.result === undefined) {
    throw new Error("Cloudflare D1 operation failed.");
  }
  if (
    pathname.endsWith("/query") &&
    (!Array.isArray(envelope.result) ||
      envelope.result.some((query) =>
        query === null ||
        typeof query !== "object" ||
        (query as { success?: unknown }).success !== true
      ))
  ) {
    throw new Error("Cloudflare D1 query failed.");
  }
  return envelope.result;
}

function backupDocument(attempt: Readonly<{
  catalogue_revision_id: string;
  object_key: string;
  d1_bookmark: string;
  content_sha256: string;
  manifest_key: string;
  manifest_sha256: string;
  linked_attempt_id: string | null;
  newest_success: boolean;
  retain_until: string | null;
}>): CatalogueBackupDocument {
  return {
    contract: "card-keepr-catalogue-backup@1",
    catalogue_revision_id: attempt.catalogue_revision_id,
    object_key: attempt.object_key,
    d1_bookmark: attempt.d1_bookmark,
    content_sha256: attempt.content_sha256,
    manifest_key: attempt.manifest_key,
    manifest_sha256: attempt.manifest_sha256,
    linked_attempt_id: attempt.linked_attempt_id,
    retention: {
      newest_success: attempt.newest_success,
      retain_until: attempt.retain_until,
    },
    verified: true,
  };
}

async function persistPreparedRestoreTarget(
  database: D1Database,
  idempotencyKey: string,
  ownerToken: string,
  disposableDatabaseId: string,
  previousGeneration: number,
  nextGeneration: number,
): Promise<void> {
  const changed = await database.prepare(
    `UPDATE catalogue_backup_attempts
     SET disposable_database_id = ?, restore_generation = ?,
         restore_phase = 'prepared'
     WHERE idempotency_key = ? AND owner_token = ?
       AND state = 'restoring_verification' AND restore_generation = ?`,
  ).bind(
    disposableDatabaseId,
    nextGeneration,
    idempotencyKey,
    ownerToken,
    previousGeneration,
  ).run();
  if (changed.meta.changes !== 1) {
    throw new AdministrationProblem(
      409,
      "backup_in_progress",
      "The disposable restore target changed concurrently.",
    );
  }
}

async function transitionRestorePhase(
  database: D1Database,
  idempotencyKey: string,
  ownerToken: string,
  from: string,
  to: string,
): Promise<void> {
  const changed = await database.prepare(
    `UPDATE catalogue_backup_attempts SET restore_phase = ?
     WHERE idempotency_key = ? AND owner_token = ?
       AND state = 'restoring_verification' AND restore_phase = ?`,
  ).bind(to, idempotencyKey, ownerToken, from).run();
  if (changed.meta.changes !== 1) {
    throw new AdministrationProblem(
      409,
      "backup_in_progress",
      "The disposable restore phase changed concurrently.",
    );
  }
}

async function transitionRestoredAttempt(
  database: D1Database,
  idempotencyKey: string,
  ownerToken: string,
): Promise<void> {
  const changed = await database.prepare(
    `UPDATE catalogue_backup_attempts
     SET state = 'verifying', restore_phase = 'imported'
     WHERE idempotency_key = ? AND owner_token = ?
       AND state = 'restoring_verification' AND restore_phase = 'importing'`,
  ).bind(idempotencyKey, ownerToken).run();
  if (changed.meta.changes !== 1) {
    throw new AdministrationProblem(
      409,
      "backup_in_progress",
      "The restored backup attempt changed concurrently.",
    );
  }
}

async function transitionExportedAttempt(
  database: D1Database,
  idempotencyKey: string,
  ownerToken: string,
  bookmark: string,
  contentSha256: string,
  exportBytes: number,
  schemaMigrationLevel: number,
): Promise<void> {
  const changed = await database.prepare(
    `UPDATE catalogue_backup_attempts
     SET state = 'restoring_verification', d1_bookmark = ?,
         content_sha256 = ?, export_bytes = ?, schema_migration_level = ?
     WHERE idempotency_key = ? AND owner_token = ? AND state = 'exporting'`,
  ).bind(
    bookmark,
    contentSha256,
    exportBytes,
    schemaMigrationLevel,
    idempotencyKey,
    ownerToken,
  ).run();
  if (changed.meta.changes !== 1) {
    throw new AdministrationProblem(
      409,
      "backup_in_progress",
      "The backup attempt state changed concurrently.",
    );
  }
}

export async function failActiveCatalogueBackupAttempt(
  database: D1Database,
  idempotencyKey: string,
  completedAt: string,
  detail: string,
): Promise<void> {
  const ownerToken = `backup:${await sha256(idempotencyKey)}`;
  await database.batch([
    database.prepare(
      `UPDATE operation_state SET recovery_health = 'degraded'
       WHERE singleton = 1 AND recovery_health = 'blocked'
         AND EXISTS (
           SELECT 1 FROM catalogue_backup_attempts
           WHERE idempotency_key = ? AND owner_token = ?
             AND state IN ('exporting', 'restoring_verification', 'verifying')
         )`,
    ).bind(idempotencyKey, ownerToken),
    database.prepare(
      `UPDATE catalogue_backup_attempts
       SET state = 'failed', failure_code = 'backup_failed',
           failure_detail = ?, completed_at = ?
       WHERE idempotency_key = ? AND owner_token = ?
         AND state NOT IN ('verified', 'failed')`,
    ).bind(detail, completedAt, idempotencyKey, ownerToken),
  ]);
}

async function failAttempt(
  database: D1Database,
  idempotencyKey: string,
  ownerToken: string,
  completedAt: string,
  code: string,
  detail: string,
): Promise<void> {
  await database.prepare(
    `UPDATE catalogue_backup_attempts
     SET state = 'failed', failure_code = ?, failure_detail = ?, completed_at = ?
     WHERE idempotency_key = ? AND owner_token = ?
       AND state NOT IN ('verified', 'failed')`,
  ).bind(code, detail, completedAt, idempotencyKey, ownerToken).run();
}

function d1Path(accountId: string, databaseId: string, action: string): string {
  return `/accounts/${encodeURIComponent(accountId)}/d1/database/${
    encodeURIComponent(databaseId)
  }/${action}`;
}

function firstQueryRow(result: Record<string, unknown>): Record<string, unknown> {
  const rows = queryRows(result);
  if (rows.length !== 1) {
    throw new Error("Restored D1 verification response is invalid.");
  }
  return rows[0]!;
}

function queryRows(result: Record<string, unknown>): Record<string, unknown>[] {
  const query = Array.isArray(result) ? result[0] : result;
  const results = query !== null && typeof query === "object"
    ? (query as { results?: unknown }).results
    : null;
  if (!Array.isArray(results)) {
    throw new Error("Restored D1 verification response is invalid.");
  }
  if (results.some((row) =>
    row === null || typeof row !== "object" || Array.isArray(row)
  )) {
    throw new Error("Restored D1 verification response is invalid.");
  }
  return results as Record<string, unknown>[];
}

function validApiCardRow(row: Record<string, unknown>): boolean {
  return [
    row.sort_game,
    row.sort_identity_kind,
    row.sort_identity_value,
    row.summary_json,
  ]
    .every((value) => typeof value === "string");
}

function apiCardId(row: Record<string, unknown>): string | null {
  if (typeof row.summary_json !== "string") return null;
  try {
    const summary = JSON.parse(row.summary_json) as Record<string, unknown>;
    return typeof summary.id === "string" ? summary.id : null;
  } catch {
    return null;
  }
}

async function digestRetainedObject(
  object: R2ObjectBody,
): Promise<{ sha256: string; size: number }> {
  const digest = new StreamingSha256();
  const reader = object.body.getReader();
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    digest.update(value);
    size += value.byteLength;
  }
  if (size !== object.size) {
    throw new Error("Retained backup object size does not match its evidence.");
  }
  return { sha256: digest.digestHex(), size };
}

function assertCompleteRestoredVerification(
  result: RestoredCatalogueVerification,
): void {
  if (
    result === null || typeof result !== "object" ||
    [
      result.schema,
      result.integrity,
      result.current_revision,
      result.representative_entities,
      result.search,
      result.provenance,
      result.audit,
      result.api,
    ].some((check) => check !== true)
  ) throw new Error("Restored Catalogue verification is incomplete.");
}

function completeRestoredVerification(): RestoredCatalogueVerification {
  return {
    schema: true,
    integrity: true,
    current_revision: true,
    representative_entities: true,
    search: true,
    provenance: true,
    audit: true,
    api: true,
  };
}

function isActiveAttemptState(value: string): boolean {
  return [
    "pending",
    "exporting",
    "restoring_verification",
    "verifying",
  ].includes(value);
}

function objectString(value: unknown, key: string): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`D1 ${key} is unavailable.`);
  }
  return requiredString((value as Record<string, unknown>)[key], key);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`D1 ${name} is unavailable.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredContentLength(response: Response): number {
  const size = Number(response.headers.get("content-length"));
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error("D1 export content length is unavailable.");
  }
  return size;
}

function validateInput(input: BackupInput): void {
  if (
    input.expectedCurrentRevisionId.length === 0 ||
    input.idempotencyKey.length === 0 ||
    !Number.isFinite(Date.parse(input.observedAt)) ||
    input.cloudflareAccountId.length === 0 ||
    input.catalogueDatabaseId.length === 0 ||
    input.disposableDatabaseId.length === 0 ||
    input.exportToken.length === 0 ||
    input.verificationToken.length === 0 ||
    (input.failedAttemptId !== undefined && input.failedAttemptId.length === 0) ||
    (input.failedAttemptDigest !== undefined &&
      !/^[a-f0-9]{64}$/u.test(input.failedAttemptDigest))
  ) {
    throw new Error("Catalogue backup input is invalid.");
  }
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function currentSchemaMigrationLevel(database: D1Database): Promise<number> {
  const row = await database.prepare(
    "SELECT migration_level FROM catalogue_schema_state WHERE singleton = 1",
  ).first<{ migration_level: number }>();
  if (!Number.isSafeInteger(row?.migration_level) || row!.migration_level <= 0) {
    throw new Error("The Catalogue schema migration level is unavailable.");
  }
  return row!.migration_level;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
