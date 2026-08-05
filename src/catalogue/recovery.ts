import { AdministrationProblem } from "./administration-problem.mjs";
import {
  cloudflareD1BackupProvider,
  type CatalogueVerificationEvidence,
  type RestoredCatalogueVerification,
} from "./backup-recovery";
import { canonicalJson, sha256Text } from "./serialization";

export type D1RecoveryProvider = Readonly<{
  currentBookmark(input: Readonly<{
    accountId: string;
    databaseId: string;
    token: string;
  }>): Promise<string>;
  timeTravelRestore(input: Readonly<{
    accountId: string;
    databaseId: string;
    token: string;
    bookmark: string;
  }>): Promise<{ bookmark: string; previousBookmark: string }>;
  prepareReplacementTarget(input: Readonly<{
    accountId: string;
    currentDatabaseId: string;
    token: string;
    recoveryId: string;
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

export type BeginCatalogueRecoveryInput = Readonly<{
  recoveryId: string;
  method: "time_travel" | "replacement_database";
  targetRevisionId: string;
  targetBookmark: string;
  targetDigest: string;
  backupAttemptId: string;
  expectedCurrentRevisionId: string;
  idempotencyKey: string;
  linkedOperationId?: string;
  observedAt: string;
  cloudflareAccountId: string;
  catalogueDatabaseId: string;
  verificationToken: string;
}>;

export type VerifyCatalogueRecoveryInput = Readonly<{
  targetDigest: string;
  idempotencyKey: string;
  observedAt: string;
  cloudflareAccountId: string;
  verificationToken: string;
}>;

export type AcceptCatalogueRecoveryInput = Readonly<{
  expectedRestoredRevisionId: string;
  targetDigest: string;
  confirmationRecoveryId: string;
  idempotencyKey: string;
  observedAt: string;
  boundDatabaseId: string;
}>;

type RecoveryRow = Readonly<{
  id: string;
  state: string;
  method: "time_travel" | "replacement_database";
  request_json: string;
  idempotency_key: string;
  target_revision_id: string;
  target_bookmark: string;
  target_digest: string;
  source_backup_attempt_id: string;
  linked_operation_id: string | null;
  expected_current_revision_id: string;
  current_bookmark: string | null;
  restored_bookmark: string | null;
  undo_bookmark: string | null;
  original_database_id: string;
  restored_database_id: string | null;
  retained_database_id: string | null;
  expected_schema_migration_level: number;
  expected_verification_json: string;
  verification_json: string | null;
  verification_idempotency_key: string | null;
  verification_request_digest: string | null;
  acceptance_idempotency_key: string | null;
  acceptance_request_digest: string | null;
  started_at: string;
  restored_at: string | null;
  verified_at: string | null;
  accepted_at: string | null;
  failure_code: string | null;
  failure_detail: string | null;
  failed_at: string | null;
}>;

type VerifiedBackupRow = Readonly<{
  idempotency_key: string;
  catalogue_revision_id: string;
  object_key: string;
  d1_bookmark: string;
  manifest_key: string;
  manifest_sha256: string;
  content_sha256: string;
  export_bytes: number;
  schema_migration_level: number;
  disposable_database_id: string;
  restore_generation: number;
  restore_phase: string;
  completed_at: string;
}>;

type BackupManifest = Readonly<{
  contract: "card-keepr-catalogue-backup-manifest@1";
  attempt_id: string;
  catalogue_revision_id: string;
  content_sha256: string;
  d1_bookmark: string;
  export_bytes: number;
  object_key: string;
  schema_migration_level: number;
  expected_evidence: CatalogueVerificationEvidence;
  verification: Readonly<{ verified: true }>;
}>;

export async function beginCatalogueRecovery(
  database: D1Database,
  backups: R2Bucket,
  input: BeginCatalogueRecoveryInput,
  provider: D1RecoveryProvider = cloudflareD1RecoveryProvider,
): Promise<Record<string, unknown>> {
  validateBeginInput(input);
  const requestJson = canonicalJson({
    recovery_id: input.recoveryId,
    method: input.method,
    target_revision_id: input.targetRevisionId,
    target_bookmark: input.targetBookmark,
    target_digest: input.targetDigest,
    backup_attempt_id: input.backupAttemptId,
    expected_current_revision_id: input.expectedCurrentRevisionId,
    idempotency_key: input.idempotencyKey,
    linked_operation_id: input.linkedOperationId ?? null,
  });
  const replay = await recoveryByIdempotency(database, input.idempotencyKey);
  if (replay !== null) {
    if (replay.request_json !== requestJson) throw idempotencyReused();
    return recoveryDocument(replay);
  }
  const identity = await recoveryRow(database, input.recoveryId);
  if (identity !== null) {
    throw new AdministrationProblem(
      409,
      "recovery_identity_conflict",
      "The recovery identity is already in use.",
    );
  }
  const state = await database.prepare(
    `SELECT catalogue.current_revision_id, operation.active_ingestion_run_id,
            operation.active_release_id, operation.active_release_expires_at,
            operation.recovery_health, operation.active_recovery_id
     FROM catalogue_state AS catalogue
     JOIN operation_state AS operation ON operation.singleton = 1
     WHERE catalogue.singleton = 1`,
  ).first<{
    current_revision_id: string;
    active_ingestion_run_id: string | null;
    active_release_id: string | null;
    active_release_expires_at: string | null;
    recovery_health: string;
    active_recovery_id: string | null;
  }>();
  if (state?.current_revision_id !== input.expectedCurrentRevisionId) {
    throw new AdministrationProblem(
      409,
      "current_revision_mismatch",
      "The expected current Catalogue Revision is stale.",
    );
  }
  if (state.active_ingestion_run_id !== null || activeRelease(state, input.observedAt)) {
    throw new AdministrationProblem(
      409,
      "mutation_not_idle",
      "Ingestion and production release must be idle before recovery.",
    );
  }
  await assertLinkedRecovery(database, state, input.linkedOperationId);

  const backup = await exactVerifiedBackup(database, input);
  const manifest = await exactBackupManifest(backups, backup);
  let currentBookmark: string | null = null;
  try {
    currentBookmark = await provider.currentBookmark({
      accountId: input.cloudflareAccountId,
      databaseId: input.catalogueDatabaseId,
      token: input.verificationToken,
    });
  } catch {
    // The provider's restore response is still required to retain an undo
    // bookmark. Failure to observe an earlier current bookmark is non-fatal.
  }
  try {
    await database.batch([
      database.prepare(
        `INSERT INTO catalogue_recovery_operations (
           id, state, method, request_json, idempotency_key,
           target_revision_id, target_bookmark, target_digest,
           source_backup_attempt_id, linked_operation_id,
           expected_current_revision_id, current_bookmark,
           original_database_id, expected_schema_migration_level,
           expected_verification_json, started_at
         ) VALUES (?, 'preparing', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        input.recoveryId,
        input.method,
        requestJson,
        input.idempotencyKey,
        input.targetRevisionId,
        input.targetBookmark,
        input.targetDigest,
        input.backupAttemptId,
        input.linkedOperationId ?? null,
        input.expectedCurrentRevisionId,
        currentBookmark,
        input.catalogueDatabaseId,
        manifest.schema_migration_level,
        canonicalJson(manifest.expected_evidence),
        input.observedAt,
      ),
      database.prepare(
        `UPDATE operation_state
         SET recovery_health = 'blocked', active_recovery_id = ?
         WHERE singleton = 1 AND active_ingestion_run_id IS NULL`,
      ).bind(input.recoveryId),
    ]);
  } catch (error) {
    const winner = await recoveryByIdempotency(database, input.idempotencyKey);
    if (winner !== null) {
      if (winner.request_json !== requestJson) throw idempotencyReused();
      return recoveryDocument(winner);
    }
    throw error;
  }

  try {
    await transitionRecovery(database, input.recoveryId, "preparing", "restoring");
    if (input.method === "time_travel") {
      const restored = await provider.timeTravelRestore({
        accountId: input.cloudflareAccountId,
        databaseId: input.catalogueDatabaseId,
        token: input.verificationToken,
        bookmark: input.targetBookmark,
      });
      await rehydrateTimeTravelJournal(database, {
        input,
        requestJson,
        currentBookmark,
        backup,
        manifest,
      });
      await transitionToValidating(database, input.recoveryId, {
        restoredBookmark: restored.bookmark,
        undoBookmark: restored.previousBookmark,
        restoredDatabaseId: input.catalogueDatabaseId,
        retainedDatabaseId: null,
        observedAt: input.observedAt,
      });
    } else {
      const target = await provider.prepareReplacementTarget({
        accountId: input.cloudflareAccountId,
        currentDatabaseId: input.catalogueDatabaseId,
        token: input.verificationToken,
        recoveryId: input.recoveryId,
      });
      const retained = await backups.get(backup.object_key);
      if (retained === null || retained.size !== backup.export_bytes) {
        throw new Error("The retained recovery backup is unavailable.");
      }
      await provider.restoreSql({
        accountId: input.cloudflareAccountId,
        databaseId: target.databaseId,
        token: input.verificationToken,
        body: retained.body,
        size: retained.size,
        etag: retained.etag,
      });
      await transitionToValidating(database, input.recoveryId, {
        restoredBookmark: input.targetBookmark,
        undoBookmark: null,
        restoredDatabaseId: target.databaseId,
        retainedDatabaseId: input.catalogueDatabaseId,
        observedAt: input.observedAt,
      });
    }
  } catch {
    await failRecovery(database, input.recoveryId, input.observedAt, "recovery_failed");
    throw new AdministrationProblem(
      502,
      "recovery_failed",
      "Catalogue recovery failed; mutation remains blocked.",
    );
  }
  return inspectCatalogueRecovery(database, input.recoveryId);
}

export async function inspectCatalogueRecovery(
  database: D1Database,
  recoveryId: string,
): Promise<Record<string, unknown>> {
  assertOpaqueId(recoveryId, "recovery_id");
  const row = await recoveryRow(database, recoveryId);
  if (row === null) {
    throw new AdministrationProblem(
      404,
      "recovery_not_found",
      "Catalogue recovery operation not found.",
    );
  }
  return recoveryDocument(row);
}

export async function verifyCatalogueRecovery(
  database: D1Database,
  recoveryId: string,
  input: VerifyCatalogueRecoveryInput,
  provider: D1RecoveryProvider = cloudflareD1RecoveryProvider,
): Promise<Record<string, unknown>> {
  assertOpaqueId(input.idempotencyKey, "idempotency_key");
  assertSha256(input.targetDigest, "target_digest");
  const row = await requiredRecovery(database, recoveryId);
  const requestDigest = await sha256Text(canonicalJson({
    recovery_id: recoveryId,
    target_digest: input.targetDigest,
  }));
  if (row.verification_idempotency_key !== null) {
    if (
      row.verification_idempotency_key !== input.idempotencyKey ||
      row.verification_request_digest !== requestDigest
    ) throw idempotencyReused();
    return recoveryDocument(row);
  }
  if (row.state === "failed") throw retainedRecoveryFailure(row);
  if (row.state !== "validating") {
    throw new AdministrationProblem(
      409,
      "recovery_not_validating",
      "The recovery operation is not ready for verification.",
    );
  }
  if (row.target_digest !== input.targetDigest) {
    throw new AdministrationProblem(
      409,
      "recovery_digest_mismatch",
      "The restored target digest does not match retained recovery evidence.",
    );
  }
  if (row.restored_database_id === null) {
    throw new Error("The restored recovery database is unavailable.");
  }
  try {
    const verification = await provider.reconstructAndVerify({
      accountId: input.cloudflareAccountId,
      databaseId: row.restored_database_id,
      token: input.verificationToken,
      ownerToken: `recovery:${await sha256Text(row.id)}`,
      expectedRevisionId: row.target_revision_id,
      expectedSchemaMigrationLevel: row.expected_schema_migration_level,
      expected: JSON.parse(
        row.expected_verification_json,
      ) as CatalogueVerificationEvidence,
    });
    assertCompleteVerification(verification);
    const changed = await database.prepare(
      `UPDATE catalogue_recovery_operations
       SET state = 'awaiting_acceptance', verification_json = ?,
           verification_idempotency_key = ?,
           verification_request_digest = ?, verified_at = ?
       WHERE id = ? AND state = 'validating'
         AND verification_idempotency_key IS NULL`,
    ).bind(
      canonicalJson(verification),
      input.idempotencyKey,
      requestDigest,
      input.observedAt,
      recoveryId,
    ).run();
    if (changed.meta.changes !== 1) {
      throw new AdministrationProblem(
        409,
        "recovery_state_changed",
        "The recovery operation changed concurrently.",
      );
    }
  } catch (error) {
    if (error instanceof AdministrationProblem) throw error;
    await failRecovery(
      database,
      recoveryId,
      input.observedAt,
      "recovery_verification_failed",
    );
    throw new AdministrationProblem(
      409,
      "recovery_verification_failed",
      "Restored Catalogue verification failed; mutation remains blocked.",
    );
  }
  return inspectCatalogueRecovery(database, recoveryId);
}

export async function acceptCatalogueRecovery(
  database: D1Database,
  recoveryId: string,
  input: AcceptCatalogueRecoveryInput,
): Promise<Record<string, unknown>> {
  assertOpaqueId(input.idempotencyKey, "idempotency_key");
  const requestDigest = await sha256Text(canonicalJson({
    recovery_id: recoveryId,
    expected_restored_revision_id: input.expectedRestoredRevisionId,
    target_digest: input.targetDigest,
    confirmation_recovery_id: input.confirmationRecoveryId,
    bound_database_id: input.boundDatabaseId,
  }));
  const row = await requiredRecovery(database, recoveryId);
  if (row.acceptance_idempotency_key !== null) {
    if (
      row.acceptance_idempotency_key !== input.idempotencyKey ||
      row.acceptance_request_digest !== requestDigest
    ) throw idempotencyReused();
    return recoveryDocument(row);
  }
  if (row.state === "failed") throw retainedRecoveryFailure(row);
  if (row.state !== "awaiting_acceptance") {
    throw new AdministrationProblem(
      409,
      "recovery_not_verified",
      "Recovery must be verified before owner acceptance.",
    );
  }
  if (input.confirmationRecoveryId !== recoveryId) {
    throw new AdministrationProblem(
      409,
      "confirmation_required",
      "Type the exact recovery operation identity.",
    );
  }
  if (row.target_digest !== input.targetDigest) {
    throw new AdministrationProblem(
      409,
      "recovery_digest_mismatch",
      "The restored target digest does not match retained recovery evidence.",
    );
  }
  if (row.target_revision_id !== input.expectedRestoredRevisionId) {
    throw new AdministrationProblem(
      409,
      "restored_revision_mismatch",
      "The expected restored Catalogue Revision is stale.",
    );
  }
  if (
    row.restored_database_id === null ||
    row.restored_database_id !== input.boundDatabaseId
  ) {
    throw new AdministrationProblem(
      409,
      "recovery_database_not_bound",
      "The verified replacement database is not the observed production binding.",
    );
  }
  const current = await database.prepare(
    "SELECT current_revision_id FROM catalogue_state WHERE singleton = 1",
  ).first<{ current_revision_id: string }>();
  if (current?.current_revision_id !== row.target_revision_id) {
    throw new AdministrationProblem(
      409,
      "restored_revision_mismatch",
      "The bound database does not expose the verified Catalogue Revision.",
    );
  }
  try {
    await database.batch([
      database.prepare(
        `UPDATE catalogue_recovery_operations
         SET state = 'accepted', acceptance_idempotency_key = ?,
             acceptance_request_digest = ?, accepted_at = ?
         WHERE id = ? AND state = 'awaiting_acceptance'`,
      ).bind(input.idempotencyKey, requestDigest, input.observedAt, recoveryId),
      database.prepare(
        `UPDATE catalogue_state SET current_revision_id = ?, published_at = ?
         WHERE singleton = 1 AND current_revision_id = ?`,
      ).bind(
        row.target_revision_id,
        input.observedAt,
        row.target_revision_id,
      ),
      database.prepare(
        `UPDATE operation_state
         SET recovery_health = 'healthy', active_recovery_id = NULL
         WHERE singleton = 1 AND recovery_health = 'blocked'
           AND active_recovery_id = ?`,
      ).bind(recoveryId),
    ]);
  } catch {
    throw new AdministrationProblem(
      409,
      "recovery_state_changed",
      "Recovery acceptance changed concurrently.",
    );
  }
  return inspectCatalogueRecovery(database, recoveryId);
}

async function exactVerifiedBackup(
  database: D1Database,
  input: BeginCatalogueRecoveryInput,
): Promise<VerifiedBackupRow> {
  const row = await database.prepare(
    `SELECT idempotency_key, catalogue_revision_id, object_key, d1_bookmark,
            manifest_key, manifest_sha256, content_sha256, export_bytes,
            schema_migration_level, disposable_database_id,
            restore_generation, restore_phase, completed_at
     FROM catalogue_backup_attempts
     WHERE idempotency_key = ? AND state = 'verified'`,
  ).bind(input.backupAttemptId).first<VerifiedBackupRow>();
  if (row === null) {
    throw new AdministrationProblem(
      404,
      "verified_backup_not_found",
      "The exact verified Backup Attempt was not found.",
    );
  }
  if (
    row.catalogue_revision_id !== input.targetRevisionId ||
    row.d1_bookmark !== input.targetBookmark ||
    row.manifest_sha256 !== input.targetDigest
  ) {
    throw new AdministrationProblem(
      409,
      "recovery_target_mismatch",
      "The recovery target does not match the exact verified Backup Attempt.",
    );
  }
  return row;
}

async function rehydrateTimeTravelJournal(
  database: D1Database,
  journal: Readonly<{
    input: BeginCatalogueRecoveryInput;
    requestJson: string;
    currentBookmark: string | null;
    backup: VerifiedBackupRow;
    manifest: BackupManifest;
  }>,
): Promise<void> {
  // Time Travel rewinds the catalogue and the administration tables together.
  // Re-establish the already-verified backup evidence and immutable recovery
  // journal before advancing the restored database.
  let backupState = await database.prepare(
    "SELECT state FROM catalogue_backup_attempts WHERE idempotency_key = ?",
  ).bind(journal.backup.idempotency_key).first<{ state: string }>();
  if (backupState?.state === "pending") {
    await database.prepare(
      "UPDATE catalogue_backup_attempts SET state = 'exporting' WHERE idempotency_key = ? AND state = 'pending'",
    ).bind(journal.backup.idempotency_key).run();
    backupState = { state: "exporting" };
  }
  if (backupState?.state === "exporting") {
    await database.prepare(
      `UPDATE catalogue_backup_attempts
       SET state = 'restoring_verification', d1_bookmark = ?,
           manifest_key = ?, content_sha256 = ?, manifest_sha256 = ?,
           export_bytes = ?, schema_migration_level = ?,
           disposable_database_id = ?, restore_generation = ?,
           restore_phase = 'prepared'
       WHERE idempotency_key = ? AND state = 'exporting'`,
    ).bind(
      journal.backup.d1_bookmark,
      journal.backup.manifest_key,
      journal.backup.content_sha256,
      journal.backup.manifest_sha256,
      journal.backup.export_bytes,
      journal.backup.schema_migration_level,
      journal.backup.disposable_database_id,
      journal.backup.restore_generation,
      journal.backup.idempotency_key,
    ).run();
    backupState = { state: "restoring_verification" };
  }
  if (backupState?.state === "restoring_verification") {
    await database.prepare(
      `UPDATE catalogue_backup_attempts
       SET state = 'verifying', restore_phase = 'imported'
       WHERE idempotency_key = ? AND state = 'restoring_verification'`,
    ).bind(journal.backup.idempotency_key).run();
    backupState = { state: "verifying" };
  }
  if (backupState?.state === "verifying") {
    await database.prepare(
      `UPDATE catalogue_backup_attempts
       SET state = 'verified', completed_at = ?, restore_phase = 'verified'
       WHERE idempotency_key = ? AND state = 'verifying'`,
    ).bind(
      journal.backup.completed_at,
      journal.backup.idempotency_key,
    ).run();
  }
  await database.prepare(
    `INSERT INTO catalogue_recovery_operations (
       id, state, method, request_json, idempotency_key,
       target_revision_id, target_bookmark, target_digest,
       source_backup_attempt_id, linked_operation_id,
       expected_current_revision_id, current_bookmark,
       original_database_id, expected_schema_migration_level,
       expected_verification_json, started_at
     ) SELECT ?, 'restoring', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE NOT EXISTS (
       SELECT 1 FROM catalogue_recovery_operations WHERE id = ?
     )`,
  ).bind(
    journal.input.recoveryId,
    journal.input.method,
    journal.requestJson,
    journal.input.idempotencyKey,
    journal.input.targetRevisionId,
    journal.input.targetBookmark,
    journal.input.targetDigest,
    journal.input.backupAttemptId,
    journal.input.linkedOperationId ?? null,
    journal.input.expectedCurrentRevisionId,
    journal.currentBookmark,
    journal.input.catalogueDatabaseId,
    journal.manifest.schema_migration_level,
    canonicalJson(journal.manifest.expected_evidence),
    journal.input.observedAt,
    journal.input.recoveryId,
  ).run();
  await database.prepare(
    `UPDATE operation_state
     SET recovery_health = 'blocked', active_recovery_id = ?
     WHERE singleton = 1`,
  ).bind(journal.input.recoveryId).run();
}

async function exactBackupManifest(
  backups: R2Bucket,
  backup: VerifiedBackupRow,
): Promise<BackupManifest> {
  const object = await backups.get(backup.manifest_key);
  if (object === null) {
    throw new AdministrationProblem(
      409,
      "recovery_manifest_unavailable",
      "The verified recovery manifest is unavailable.",
    );
  }
  let manifest: BackupManifest;
  try {
    manifest = await object.json<BackupManifest>();
  } catch {
    throw new AdministrationProblem(
      409,
      "recovery_manifest_invalid",
      "The verified recovery manifest is invalid.",
    );
  }
  if (
    manifest.contract !== "card-keepr-catalogue-backup-manifest@1" ||
    manifest.attempt_id !== backup.idempotency_key ||
    manifest.catalogue_revision_id !== backup.catalogue_revision_id ||
    manifest.content_sha256 !== backup.content_sha256 ||
    manifest.d1_bookmark !== backup.d1_bookmark ||
    manifest.export_bytes !== backup.export_bytes ||
    manifest.object_key !== backup.object_key ||
    manifest.schema_migration_level !== backup.schema_migration_level ||
    manifest.verification?.verified !== true ||
    !validVerificationEvidence(manifest.expected_evidence)
  ) {
    throw new AdministrationProblem(
      409,
      "recovery_manifest_mismatch",
      "The recovery manifest does not match retained verified evidence.",
    );
  }
  return manifest;
}

async function assertLinkedRecovery(
  database: D1Database,
  state: Readonly<{
    recovery_health: string;
    active_recovery_id: string | null;
  }>,
  linkedOperationId: string | undefined,
): Promise<void> {
  if (linkedOperationId !== undefined) {
    const linked = await recoveryRow(database, linkedOperationId);
    if (linked?.state !== "failed") {
      throw new AdministrationProblem(
        409,
        "source_recovery_not_failed",
        "The linked recovery operation is not failed.",
      );
    }
    const child = await database.prepare(
      `SELECT id FROM catalogue_recovery_operations
       WHERE linked_operation_id = ? LIMIT 1`,
    ).bind(linkedOperationId).first<{ id: string }>();
    if (child !== null) {
      throw new AdministrationProblem(
        409,
        "recovery_link_superseded",
        "The failed recovery operation already has an immutable child.",
      );
    }
  }
  if (state.recovery_health === "blocked") {
    if (linkedOperationId === undefined) {
      throw new AdministrationProblem(
        409,
        "recovery_link_required",
        "Blocked recovery requires an exact linked operation.",
      );
    }
    if (state.active_recovery_id !== linkedOperationId) {
      throw new AdministrationProblem(
        409,
        "recovery_link_mismatch",
        "The linked recovery operation is not the current failed operation.",
      );
    }
  } else if (linkedOperationId !== undefined) {
    throw new AdministrationProblem(
      409,
      "recovery_link_not_required",
      "A healthy recovery state cannot continue a failed operation.",
    );
  }
}

async function transitionRecovery(
  database: D1Database,
  recoveryId: string,
  from: string,
  to: string,
): Promise<void> {
  const result = await database.prepare(
    "UPDATE catalogue_recovery_operations SET state = ? WHERE id = ? AND state = ?",
  ).bind(to, recoveryId, from).run();
  if (result.meta.changes !== 1) {
    throw new AdministrationProblem(
      409,
      "recovery_state_changed",
      "The recovery operation changed concurrently.",
    );
  }
}

async function transitionToValidating(
  database: D1Database,
  recoveryId: string,
  input: Readonly<{
    restoredBookmark: string;
    undoBookmark: string | null;
    restoredDatabaseId: string;
    retainedDatabaseId: string | null;
    observedAt: string;
  }>,
): Promise<void> {
  const result = await database.prepare(
    `UPDATE catalogue_recovery_operations
     SET state = 'validating', restored_bookmark = ?, undo_bookmark = ?,
         restored_database_id = ?, retained_database_id = ?, restored_at = ?
     WHERE id = ? AND state = 'restoring'`,
  ).bind(
    input.restoredBookmark,
    input.undoBookmark,
    input.restoredDatabaseId,
    input.retainedDatabaseId,
    input.observedAt,
    recoveryId,
  ).run();
  if (result.meta.changes !== 1) {
    throw new AdministrationProblem(
      409,
      "recovery_state_changed",
      "The recovery operation changed concurrently.",
    );
  }
}

async function failRecovery(
  database: D1Database,
  recoveryId: string,
  observedAt: string,
  code: string,
): Promise<void> {
  await database.prepare(
    `UPDATE catalogue_recovery_operations
     SET state = 'failed', failure_code = ?, failure_detail = ?, failed_at = ?
     WHERE id = ? AND state IN (
       'preparing', 'restoring', 'validating', 'awaiting_acceptance'
     )`,
  ).bind(
    code,
    "Catalogue recovery failed; mutation remains blocked.",
    observedAt,
    recoveryId,
  ).run();
}

async function requiredRecovery(
  database: D1Database,
  recoveryId: string,
): Promise<RecoveryRow> {
  assertOpaqueId(recoveryId, "recovery_id");
  const row = await recoveryRow(database, recoveryId);
  if (row === null) {
    throw new AdministrationProblem(
      404,
      "recovery_not_found",
      "Catalogue recovery operation not found.",
    );
  }
  return row;
}

function recoveryRow(
  database: D1Database,
  recoveryId: string,
): Promise<RecoveryRow | null> {
  return database.prepare(
    "SELECT * FROM catalogue_recovery_operations WHERE id = ?",
  ).bind(recoveryId).first<RecoveryRow>();
}

function recoveryByIdempotency(
  database: D1Database,
  idempotencyKey: string,
): Promise<RecoveryRow | null> {
  return database.prepare(
    "SELECT * FROM catalogue_recovery_operations WHERE idempotency_key = ?",
  ).bind(idempotencyKey).first<RecoveryRow>();
}

async function recoveryDocument(
  row: RecoveryRow,
): Promise<Record<string, unknown>> {
  return {
    contract: "card-keepr-catalogue-recovery@1",
    id: row.id,
    state: row.state,
    method: row.method,
    target_revision_id: row.target_revision_id,
    target_bookmark: row.target_bookmark,
    target_digest: row.target_digest,
    source_backup_attempt_id: row.source_backup_attempt_id,
    linked_operation_id: row.linked_operation_id,
    expected_current_revision_id: row.expected_current_revision_id,
    current_bookmark: row.current_bookmark,
    restored_bookmark: row.restored_bookmark,
    undo_bookmark: row.undo_bookmark,
    original_database_id: row.original_database_id,
    restored_database_id: row.restored_database_id,
    retained_database_id: row.retained_database_id,
    verification: row.verification_json === null
      ? null
      : JSON.parse(row.verification_json) as Record<string, unknown>,
    started_at: row.started_at,
    restored_at: row.restored_at,
    verified_at: row.verified_at,
    accepted_at: row.accepted_at,
    failure: row.state === "failed"
      ? { code: row.failure_code, detail: row.failure_detail }
      : null,
    operation_digest: await sha256Text(canonicalJson({
      id: row.id,
      state: row.state,
      method: row.method,
      target_revision_id: row.target_revision_id,
      target_bookmark: row.target_bookmark,
      target_digest: row.target_digest,
      restored_database_id: row.restored_database_id,
      retained_database_id: row.retained_database_id,
      verification: row.verification_json,
      accepted_at: row.accepted_at,
      failure_code: row.failure_code,
    })),
  };
}

function retainedRecoveryFailure(row: RecoveryRow): AdministrationProblem {
  return new AdministrationProblem(
    409,
    row.failure_code ?? "recovery_failed",
    row.failure_detail ?? "Catalogue recovery failed; mutation remains blocked.",
  );
}

function idempotencyReused(): AdministrationProblem {
  return new AdministrationProblem(
    409,
    "idempotency_key_reused",
    "The idempotency key is already bound to another recovery request.",
  );
}

function activeRelease(
  state: Readonly<{
    active_release_id: string | null;
    active_release_expires_at: string | null;
  }>,
  observedAt: string,
): boolean {
  return state.active_release_id !== null &&
    state.active_release_expires_at !== null &&
    state.active_release_expires_at > observedAt;
}

function validateBeginInput(input: BeginCatalogueRecoveryInput): void {
  assertOpaqueId(input.recoveryId, "recovery_id");
  assertOpaqueId(input.targetRevisionId, "target_revision_id");
  assertOpaqueId(input.backupAttemptId, "backup_attempt_id");
  assertOpaqueId(input.expectedCurrentRevisionId, "expected_current_revision_id");
  assertOpaqueId(input.idempotencyKey, "idempotency_key");
  if (input.linkedOperationId !== undefined) {
    assertOpaqueId(input.linkedOperationId, "linked_operation_id");
  }
  assertSha256(input.targetDigest, "target_digest");
  if (
    (input.method !== "time_travel" &&
      input.method !== "replacement_database") ||
    input.targetBookmark.length === 0 ||
    !Number.isFinite(Date.parse(input.observedAt)) ||
    input.cloudflareAccountId.length === 0 ||
    input.catalogueDatabaseId.length === 0 ||
    input.verificationToken.length === 0
  ) {
    throw new AdministrationProblem(
      422,
      "invalid_recovery_request",
      "The recovery request is invalid.",
    );
  }
}

function assertOpaqueId(value: string, name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value)) {
    throw new AdministrationProblem(
      422,
      "invalid_recovery_request",
      `${name} is invalid.`,
    );
  }
}

function assertSha256(value: string, name: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new AdministrationProblem(
      422,
      "invalid_recovery_request",
      `${name} must be a lower-case SHA-256 digest.`,
    );
  }
}

function validVerificationEvidence(
  value: unknown,
): value is CatalogueVerificationEvidence {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const evidence = value as Record<string, unknown>;
  return [
    "cards",
    "printings",
    "products",
    "legality_rules",
    "api_documents",
    "search_terms",
    "search_chunks",
    "provenance",
    "audit_rows",
  ].every((key) => Number.isSafeInteger(evidence[key]) && Number(evidence[key]) >= 0);
}

function assertCompleteVerification(
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

export const cloudflareD1RecoveryProvider: D1RecoveryProvider = {
  async currentBookmark(input) {
    const result = await cloudflareRequest(
      `/accounts/${encodeURIComponent(input.accountId)}/d1/database/${
        encodeURIComponent(input.databaseId)
      }/time_travel/bookmark`,
      input.token,
      "GET",
    );
    return requiredString(result, "bookmark");
  },

  async timeTravelRestore(input) {
    const result = await cloudflareRequest(
      `/accounts/${encodeURIComponent(input.accountId)}/d1/database/${
        encodeURIComponent(input.databaseId)
      }/time_travel/restore?bookmark=${encodeURIComponent(input.bookmark)}`,
      input.token,
      "POST",
    );
    return {
      bookmark: requiredString(result, "bookmark"),
      previousBookmark: requiredString(result, "previous_bookmark"),
    };
  },

  async prepareReplacementTarget(input) {
    const suffix = (await sha256Text(input.recoveryId)).slice(0, 16);
    const result = await cloudflareRequest(
      `/accounts/${encodeURIComponent(input.accountId)}/d1/database`,
      input.token,
      "POST",
      { name: `card-keepr-recovery-${suffix}` },
    );
    return { databaseId: requiredString(result, "uuid") };
  },

  restoreSql(input) {
    return cloudflareD1BackupProvider.restoreSql(input);
  },

  reconstructAndVerify(input) {
    return cloudflareD1BackupProvider.reconstructAndVerify(input);
  },
};

async function cloudflareRequest(
  pathname: string,
  token: string,
  method: "GET" | "POST",
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
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
    result?: Record<string, unknown>;
  }>();
  if (!response.ok || envelope.success !== true || envelope.result === undefined) {
    throw new Error("Cloudflare D1 recovery operation failed.");
  }
  return envelope.result;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  if (typeof result !== "string" || result.length === 0) {
    throw new Error(`Cloudflare D1 recovery ${key} is unavailable.`);
  }
  return result;
}
