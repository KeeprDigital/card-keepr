import { verifyCompositionArtifacts } from "./composition-artifacts";
import { AdministrationProblem, type CatalogueStore, canonicalJson, sha256Text } from "../shared";
import {
  type CatalogueVerificationEvidence,
  cloudflareD1BackupProvider,
  type RestoredCatalogueVerification,
} from "./backup-recovery";
import * as recoveryStatements from "./recovery-repository";

export type D1RecoveryProvider = Readonly<{
  currentBookmark(
    input: Readonly<{
      accountId: string;
      databaseId: string;
      token: string;
    }>,
  ): Promise<string>;
  timeTravelRestore(
    input: Readonly<{
      accountId: string;
      databaseId: string;
      token: string;
      bookmark: string;
    }>,
  ): Promise<{ bookmark: string; previousBookmark: string }>;
  prepareReplacementTarget(
    input: Readonly<{
      accountId: string;
      currentDatabaseId: string;
      token: string;
      recoveryId: string;
    }>,
  ): Promise<{ databaseId: string }>;
  restoreSql(
    input: Readonly<{
      accountId: string;
      databaseId: string;
      token: string;
      body: ReadableStream<Uint8Array>;
      size: number;
      etag: string;
    }>,
  ): Promise<void>;
  reconstructAndVerify(
    input: Readonly<{
      accountId: string;
      databaseId: string;
      token: string;
      ownerToken: string;
      expectedRevisionId: string;
      expectedSchemaMigrationLevel: number;
      expected: CatalogueVerificationEvidence;
    }>,
  ): Promise<RestoredCatalogueVerification>;
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

export async function enforceRecoveryRestoreGuard(database: CatalogueStore): Promise<void> {
  await recoveryStatements.enforceRestoreGuardStatement(database).run();
}

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

type RecoveryJournal = Readonly<{
  contract: "card-keepr-catalogue-recovery-journal@1";
  recovery: RecoveryRow;
  backup: VerifiedBackupRow;
}>;

export async function beginCatalogueRecovery(
  database: CatalogueStore,
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
  let replay = await recoveryByIdempotency(database, input.idempotencyKey);
  if (replay !== null) {
    if (replay.request_json !== requestJson) throw idempotencyReused();
    return recoveryDocument(database, replay);
  }
  await hydrateRetainedRecoveryIfPresent(database, backups, input.recoveryId, true);
  replay = await recoveryByIdempotency(database, input.idempotencyKey);
  if (replay !== null) {
    if (replay.request_json !== requestJson) throw idempotencyReused();
    return recoveryDocument(database, replay);
  }
  const identity = await recoveryRow(database, input.recoveryId);
  if (identity !== null) {
    throw new AdministrationProblem(409, "recovery_identity_conflict", "The recovery identity is already in use.");
  }
  const state = await recoveryStatements.recoveryOperationStateStatement(database).first<{
    current_revision_id: string;
    active_ingestion_run_id: string | null;
    active_production_release_id: string | null;
    active_production_release_expires_at: string | null;
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
  if (state.active_ingestion_run_id !== null || activeProductionRelease(state, input.observedAt)) {
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
      recoveryStatements.guardRecoveryStartStatement(database, {
        expectedCurrentRevisionId: input.expectedCurrentRevisionId,
        observedAt: input.observedAt,
        linkedOperationId: input.linkedOperationId ?? null,
      }),
      recoveryStatements.insertRecoveryOperationStatement(database, {
        recoveryId: input.recoveryId,
        method: input.method,
        requestJson,
        idempotencyKey: input.idempotencyKey,
        targetRevisionId: input.targetRevisionId,
        targetBookmark: input.targetBookmark,
        targetDigest: input.targetDigest,
        backupAttemptId: input.backupAttemptId,
        linkedOperationId: input.linkedOperationId ?? null,
        expectedCurrentRevisionId: input.expectedCurrentRevisionId,
        currentBookmark,
        catalogueDatabaseId: input.catalogueDatabaseId,
        schema_migration_level: manifest.schema_migration_level,
        expected_evidenceJson: canonicalJson(manifest.expected_evidence),
        observedAt: input.observedAt,
      }),
      recoveryStatements.reserveRecoveryOperationStatement(database, {
        recoveryId: input.recoveryId,
        observedAt: input.observedAt,
        linkedOperationId: input.linkedOperationId ?? null,
      }),
      recoveryStatements.guardRecoveryReservationStatement(database, { recoveryId: input.recoveryId }),
    ]);
  } catch (_error) {
    if (_error instanceof Error && _error.message.includes("recovery_writer_unsettled"))
      throw new AdministrationProblem(
        409,
        "recovery_writer_unsettled",
        "Recovery must wait for every source and staging write to conclusively finish.",
      );
    const winner = await recoveryByIdempotency(database, input.idempotencyKey);
    if (winner !== null) {
      if (winner.request_json !== requestJson) throw idempotencyReused();
      return recoveryDocument(database, winner);
    }
    throw new AdministrationProblem(
      409,
      "recovery_state_changed",
      "Catalogue state changed before the recovery block was acquired.",
    );
  }

  try {
    await startRecoveryRestore(database, input.recoveryId);
    await persistRecoveryJournal(backups, await requiredRecovery(database, input.recoveryId), backup);
    if (input.method === "time_travel") {
      const restored = await provider.timeTravelRestore({
        accountId: input.cloudflareAccountId,
        databaseId: input.catalogueDatabaseId,
        token: input.verificationToken,
        bookmark: input.targetBookmark,
      });
      await hydrateRecoveryJournal(database, backups, input.recoveryId);
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
    await persistRecoveryJournal(backups, await requiredRecovery(database, input.recoveryId), backup);
  } catch {
    await hydrateRecoveryJournal(database, backups, input.recoveryId).catch(() => undefined);
    await failRecovery(database, input.recoveryId, input.observedAt, "recovery_failed");
    const failed = await recoveryRow(database, input.recoveryId);
    if (failed !== null) {
      await persistRecoveryJournal(backups, failed, backup).catch(() => undefined);
    }
    throw new AdministrationProblem(502, "recovery_failed", "Catalogue recovery failed; mutation remains blocked.");
  }
  return inspectCatalogueRecovery(database, backups, input.recoveryId);
}

export async function inspectCatalogueRecovery(
  database: CatalogueStore,
  backups: R2Bucket,
  recoveryId: string,
): Promise<Record<string, unknown>> {
  assertOpaqueId(recoveryId, "recovery_id");
  await hydrateRecoveryJournal(database, backups, recoveryId);
  const row = await recoveryRow(database, recoveryId);
  if (row === null) {
    throw new AdministrationProblem(404, "recovery_not_found", "Catalogue recovery operation not found.");
  }
  return recoveryDocument(database, row);
}

export async function verifyCatalogueRecovery(
  database: CatalogueStore,
  backups: R2Bucket,
  recoveryId: string,
  input: VerifyCatalogueRecoveryInput,
  provider: D1RecoveryProvider = cloudflareD1RecoveryProvider,
  artifacts?: { catalogue: R2Bucket; images: R2Bucket },
): Promise<Record<string, unknown>> {
  assertOpaqueId(input.idempotencyKey, "idempotency_key");
  assertSha256(input.targetDigest, "target_digest");
  await hydrateRecoveryJournal(database, backups, recoveryId);
  const row = await requiredRecovery(database, recoveryId);
  const requestDigest = await sha256Text(
    canonicalJson({
      recovery_id: recoveryId,
      target_digest: input.targetDigest,
    }),
  );
  if (row.verification_idempotency_key !== null) {
    if (row.verification_idempotency_key !== input.idempotencyKey || row.verification_request_digest !== requestDigest)
      throw idempotencyReused();
    const retained = await requiredRecoveryJournal(backups, recoveryId);
    await persistRecoveryJournal(backups, row, retained.backup);
    return recoveryDocument(database, row);
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
    const expected = JSON.parse(row.expected_verification_json) as CatalogueVerificationEvidence;
    if (expected.composition_snapshot) {
      if (!artifacts) throw new Error("Private composition artifacts are required for Catalogue Recovery.");
      await verifyCompositionArtifacts(
        database,
        artifacts.catalogue,
        artifacts.images,
        row.target_revision_id,
        expected.composition_snapshot,
      );
    }
    const verification = await provider.reconstructAndVerify({
      accountId: input.cloudflareAccountId,
      databaseId: row.restored_database_id,
      token: input.verificationToken,
      ownerToken: `recovery:${await sha256Text(row.id)}`,
      expectedRevisionId: row.target_revision_id,
      expectedSchemaMigrationLevel: row.expected_schema_migration_level,
      expected: JSON.parse(row.expected_verification_json) as CatalogueVerificationEvidence,
    });
    assertCompleteVerification(verification);
    const changed = await recoveryStatements
      .completeRecoveryVerificationStatement(database, {
        verificationJson: canonicalJson(verification),
        idempotencyKey: input.idempotencyKey,
        requestDigest,
        observedAt: input.observedAt,
        recoveryId,
      })
      .run();
    if (changed.meta.changes !== 1) {
      throw new AdministrationProblem(409, "recovery_state_changed", "The recovery operation changed concurrently.");
    }
  } catch (error) {
    if (error instanceof AdministrationProblem) throw error;
    await failRecovery(database, recoveryId, input.observedAt, "recovery_verification_failed");
    const journal = await requiredRecoveryJournal(backups, recoveryId);
    await persistRecoveryJournal(backups, await requiredRecovery(database, recoveryId), journal.backup);
    throw new AdministrationProblem(
      409,
      "recovery_verification_failed",
      "Restored Catalogue verification failed; mutation remains blocked.",
    );
  }
  const completed = await requiredRecovery(database, recoveryId);
  const journal = await requiredRecoveryJournal(backups, recoveryId);
  await persistRecoveryJournal(backups, completed, journal.backup);
  return inspectCatalogueRecovery(database, backups, recoveryId);
}

export async function acceptCatalogueRecovery(
  database: CatalogueStore,
  backups: R2Bucket,
  recoveryId: string,
  input: AcceptCatalogueRecoveryInput,
): Promise<Record<string, unknown>> {
  assertOpaqueId(input.idempotencyKey, "idempotency_key");
  await hydrateRecoveryJournal(database, backups, recoveryId);
  const requestDigest = await sha256Text(
    canonicalJson({
      recovery_id: recoveryId,
      expected_restored_revision_id: input.expectedRestoredRevisionId,
      target_digest: input.targetDigest,
      confirmation_recovery_id: input.confirmationRecoveryId,
      bound_database_id: input.boundDatabaseId,
    }),
  );
  const row = await requiredRecovery(database, recoveryId);
  if (row.acceptance_idempotency_key !== null) {
    if (row.acceptance_idempotency_key !== input.idempotencyKey || row.acceptance_request_digest !== requestDigest)
      throw idempotencyReused();
    const retained = await requiredRecoveryJournal(backups, recoveryId);
    await releaseAcceptedRecoveryIfSafe(database, row, retained.backup, input.boundDatabaseId);
    await persistRecoveryJournal(backups, row, retained.backup);
    return recoveryDocument(database, row);
  }
  if (row.state === "failed") throw retainedRecoveryFailure(row);
  if (row.state !== "awaiting_acceptance") {
    throw new AdministrationProblem(409, "recovery_not_verified", "Recovery must be verified before owner acceptance.");
  }
  if (input.confirmationRecoveryId !== recoveryId) {
    throw new AdministrationProblem(409, "confirmation_required", "Type the exact recovery operation identity.");
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
  if (row.restored_database_id === null || row.restored_database_id !== input.boundDatabaseId) {
    throw new AdministrationProblem(
      409,
      "recovery_database_not_bound",
      "The verified replacement database is not the observed production binding.",
    );
  }
  const current = await recoveryStatements
    .recoveryCurrentRevisionStatement(database)
    .first<{ current_revision_id: string }>();
  if (current?.current_revision_id !== row.target_revision_id) {
    throw new AdministrationProblem(
      409,
      "restored_revision_mismatch",
      "The bound database does not expose the verified Catalogue Revision.",
    );
  }
  const retained = await requiredRecoveryJournal(backups, recoveryId);
  await assertRecoveryEvidenceMatches(database, row, retained.backup, input.boundDatabaseId);
  try {
    await database.batch([
      recoveryStatements.guardRecoveryAcceptanceStatement(database, {
        recoveryId,
        target_revision_id: row.target_revision_id,
      }),
      ...recoveryStatements.classifyRestoredWorkStatements(database, recoveryId),
      recoveryStatements.acceptRecoveryOperationStatement(database, {
        idempotencyKey: input.idempotencyKey,
        requestDigest,
        observedAt: input.observedAt,
        recoveryId,
      }),
      recoveryStatements.confirmRecoveredCatalogueRevisionStatement(database, {
        target_revision_id: row.target_revision_id,
        observedAt: input.observedAt,
      }),
      recoveryStatements.releaseAcceptedRecoveryStatement(database, { recoveryId }),
      recoveryStatements.guardAcceptedRecoveryStatement(database, {
        recoveryId,
        idempotencyKey: input.idempotencyKey,
        requestDigest,
      }),
    ]);
  } catch {
    const winner = await requiredRecovery(database, recoveryId);
    if (winner.acceptance_idempotency_key !== null) {
      if (
        winner.acceptance_idempotency_key !== input.idempotencyKey ||
        winner.acceptance_request_digest !== requestDigest
      )
        throw idempotencyReused();
      const retained = await requiredRecoveryJournal(backups, recoveryId);
      await persistRecoveryJournal(backups, winner, retained.backup);
      return recoveryDocument(database, winner);
    }
    throw new AdministrationProblem(409, "recovery_state_changed", "Recovery acceptance changed concurrently.");
  }
  const accepted = await requiredRecovery(database, recoveryId);
  await persistRecoveryJournal(backups, accepted, retained.backup);
  return inspectCatalogueRecovery(database, backups, recoveryId);
}

async function releaseAcceptedRecoveryIfSafe(
  database: CatalogueStore,
  recovery: RecoveryRow,
  backup: VerifiedBackupRow,
  boundDatabaseId: string,
): Promise<void> {
  const operation = await recoveryStatements.recoveryGuardStateStatement(database).first<{
    recovery_health: string;
    active_recovery_id: string | null;
    recovery_restore_guard: string;
  }>();
  if (
    operation?.recovery_health === "healthy" &&
    operation.active_recovery_id === null &&
    operation.recovery_restore_guard === "clear"
  )
    return;
  await assertRecoveryEvidenceMatches(database, recovery, backup, boundDatabaseId);
  try {
    await database.batch([
      recoveryStatements.guardRecoveryReleaseStatement(database, { id: recovery.id }),
      ...recoveryStatements.classifyRestoredWorkStatements(database, recovery.id),
      recoveryStatements.clearBlockedRecoveryStatement(database, { id: recovery.id }),
      recoveryStatements.guardHealthyRecoveryStatement(database),
    ]);
  } catch {
    throw new AdministrationProblem(409, "recovery_state_changed", "Accepted recovery health changed concurrently.");
  }
}

async function assertRecoveryEvidenceMatches(
  database: CatalogueStore,
  recovery: RecoveryRow,
  backup: VerifiedBackupRow,
  boundDatabaseId: string,
): Promise<void> {
  if (recovery.restored_database_id === null || recovery.restored_database_id !== boundDatabaseId) {
    throw new AdministrationProblem(
      409,
      "recovery_database_not_bound",
      "The accepted recovery database is not the observed production binding.",
    );
  }
  if (
    backup.idempotency_key !== recovery.source_backup_attempt_id ||
    backup.catalogue_revision_id !== recovery.target_revision_id ||
    backup.d1_bookmark !== recovery.target_bookmark ||
    backup.manifest_sha256 !== recovery.target_digest ||
    backup.schema_migration_level !== recovery.expected_schema_migration_level
  ) {
    throw new AdministrationProblem(
      409,
      "recovery_journal_invalid",
      "Accepted recovery evidence does not match the retained verified target.",
    );
  }
  const localBackup = await recoveryStatements
    .verifiedBackupSchemaEvidenceStatement(database, { idempotency_key: backup.idempotency_key })
    .first<{
      catalogue_revision_id: string;
      d1_bookmark: string;
      manifest_sha256: string;
      schema_migration_level: number;
      current_schema_migration_level: number;
    }>();
  if (
    localBackup?.catalogue_revision_id !== recovery.target_revision_id ||
    localBackup.d1_bookmark !== recovery.target_bookmark ||
    localBackup.manifest_sha256 !== recovery.target_digest ||
    localBackup.schema_migration_level !== recovery.expected_schema_migration_level ||
    localBackup.current_schema_migration_level !== recovery.expected_schema_migration_level
  ) {
    throw new AdministrationProblem(
      409,
      "recovery_journal_invalid",
      "The local verified Backup Attempt does not match the accepted target.",
    );
  }
  const local = await recoveryStatements
    .recoveryEvidenceCurrentRevisionStatement(database)
    .first<{ current_revision_id: string }>();
  if (local?.current_revision_id !== recovery.target_revision_id) {
    throw new AdministrationProblem(
      409,
      "restored_revision_mismatch",
      "The bound database does not expose the accepted Catalogue Revision.",
    );
  }
}

async function exactVerifiedBackup(
  database: CatalogueStore,
  input: BeginCatalogueRecoveryInput,
): Promise<VerifiedBackupRow> {
  const row = await recoveryStatements
    .verifiedRecoveryBackupStatement(database, { backupAttemptId: input.backupAttemptId })
    .first<VerifiedBackupRow>();
  if (row === null) {
    const known = await recoveryStatements
      .recoveryBackupSchemaStatement(database, { backupAttemptId: input.backupAttemptId })
      .first<{
        schema_migration_level: number;
        migration_level: number;
      }>();
    if (known !== null && known.schema_migration_level !== known.migration_level) {
      throw new AdministrationProblem(
        409,
        "recovery_backup_schema_incompatible",
        "The verified Backup Attempt does not match the current catalogue schema.",
      );
    }
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

function recoveryJournalKey(recoveryId: string): string {
  return `recovery-journals/${recoveryId}.json`;
}

async function persistRecoveryJournal(
  backups: R2Bucket,
  recovery: RecoveryRow,
  backup: VerifiedBackupRow,
): Promise<void> {
  await backups.put(
    recoveryJournalKey(recovery.id),
    canonicalJson({
      contract: "card-keepr-catalogue-recovery-journal@1",
      recovery,
      backup,
    } satisfies RecoveryJournal),
    { httpMetadata: { contentType: "application/json" } },
  );
}

async function requiredRecoveryJournal(backups: R2Bucket, recoveryId: string): Promise<RecoveryJournal> {
  const object = await backups.get(recoveryJournalKey(recoveryId));
  if (object === null) {
    throw new AdministrationProblem(404, "recovery_not_found", "Catalogue recovery operation not found.");
  }
  const journal = await object.json<RecoveryJournal>();
  if (
    journal.contract !== "card-keepr-catalogue-recovery-journal@1" ||
    journal.recovery.id !== recoveryId ||
    journal.recovery.source_backup_attempt_id !== journal.backup.idempotency_key
  ) {
    throw new AdministrationProblem(409, "recovery_journal_invalid", "The retained recovery journal is invalid.");
  }
  return journal;
}

async function hydrateRecoveryJournal(
  database: CatalogueStore,
  backups: R2Bucket,
  recoveryId: string,
  ambiguousRestoringIsFailure = false,
): Promise<void> {
  const existing = await recoveryRow(database, recoveryId);
  if (existing !== null) {
    if (ambiguousRestoringIsFailure && existing.state === "restoring") {
      const retained = await requiredRecoveryJournal(backups, recoveryId);
      await failRecovery(database, recoveryId, new Date().toISOString(), "recovery_outcome_ambiguous");
      await persistRecoveryJournal(backups, await requiredRecovery(database, recoveryId), retained.backup);
    }
    return;
  }
  const journal = await requiredRecoveryJournal(backups, recoveryId);
  if (
    journal.recovery.linked_operation_id !== null &&
    (await recoveryRow(database, journal.recovery.linked_operation_id)) === null
  ) {
    await hydrateRecoveryJournal(database, backups, journal.recovery.linked_operation_id);
  }
  await rehydrateVerifiedBackup(database, journal.backup);
  const row = journal.recovery;
  await recoveryStatements
    .insertRecoveryJournalStatement(database, {
      id: row.id,
      state: row.state,
      method: row.method,
      request_json: row.request_json,
      idempotency_key: row.idempotency_key,
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
      expected_schema_migration_level: row.expected_schema_migration_level,
      expected_verification_json: row.expected_verification_json,
      verification_json: row.verification_json,
      verification_idempotency_key: row.verification_idempotency_key,
      verification_request_digest: row.verification_request_digest,
      acceptance_idempotency_key: row.acceptance_idempotency_key,
      acceptance_request_digest: row.acceptance_request_digest,
      started_at: row.started_at,
      restored_at: row.restored_at,
      verified_at: row.verified_at,
      accepted_at: row.accepted_at,
      failure_code: row.failure_code,
      failure_detail: row.failure_detail,
      failed_at: row.failed_at,
    })
    .run();
  const changed = await recoveryStatements
    .restoreRecoveryReservationStatement(database, { id: row.id, linked_operation_id: row.linked_operation_id })
    .run();
  if (changed.meta.changes !== 1) {
    throw new AdministrationProblem(
      409,
      "recovery_state_changed",
      "The restored database cannot acquire the retained recovery journal.",
    );
  }
  if (ambiguousRestoringIsFailure && row.state === "restoring") {
    await failRecovery(database, recoveryId, new Date().toISOString(), "recovery_outcome_ambiguous");
    await persistRecoveryJournal(backups, await requiredRecovery(database, recoveryId), journal.backup);
  }
}

async function hydrateRetainedRecoveryIfPresent(
  database: CatalogueStore,
  backups: R2Bucket,
  recoveryId: string,
  ambiguousRestoringIsFailure: boolean,
): Promise<void> {
  try {
    await hydrateRecoveryJournal(database, backups, recoveryId, ambiguousRestoringIsFailure);
  } catch (error) {
    if (error instanceof AdministrationProblem && error.code === "recovery_not_found") return;
    throw error;
  }
}

async function rehydrateVerifiedBackup(database: CatalogueStore, backup: VerifiedBackupRow): Promise<void> {
  let backupState = await recoveryStatements
    .rehydratedBackupStateStatement(database, { idempotency_key: backup.idempotency_key })
    .first<{ state: string }>();
  if (backupState === null) {
    throw new AdministrationProblem(
      409,
      "recovery_backup_missing",
      "The restored database does not contain the recovery Backup Attempt.",
    );
  }
  if (backupState?.state === "pending") {
    await recoveryStatements
      .startRehydratedBackupExportStatement(database, { idempotency_key: backup.idempotency_key })
      .run();
    backupState = { state: "exporting" };
  }
  if (backupState?.state === "exporting") {
    await recoveryStatements
      .restoreRehydratedBackupEvidenceStatement(database, {
        d1_bookmark: backup.d1_bookmark,
        manifest_key: backup.manifest_key,
        content_sha256: backup.content_sha256,
        manifest_sha256: backup.manifest_sha256,
        export_bytes: backup.export_bytes,
        schema_migration_level: backup.schema_migration_level,
        disposable_database_id: backup.disposable_database_id,
        restore_generation: backup.restore_generation,
        idempotency_key: backup.idempotency_key,
      })
      .run();
    backupState = { state: "restoring_verification" };
  }
  if (backupState?.state === "restoring_verification") {
    await recoveryStatements
      .startRehydratedBackupVerificationStatement(database, { idempotency_key: backup.idempotency_key })
      .run();
    backupState = { state: "verifying" };
  }
  if (backupState?.state === "verifying") {
    await recoveryStatements
      .completeRehydratedBackupStatement(database, {
        completed_at: backup.completed_at,
        idempotency_key: backup.idempotency_key,
      })
      .run();
    backupState = { state: "verified" };
  }
  if (backupState.state !== "verified") {
    throw new AdministrationProblem(
      409,
      "recovery_backup_invalid",
      "The restored recovery Backup Attempt cannot be rehydrated.",
    );
  }
}

async function exactBackupManifest(backups: R2Bucket, backup: VerifiedBackupRow): Promise<BackupManifest> {
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
    throw new AdministrationProblem(409, "recovery_manifest_invalid", "The verified recovery manifest is invalid.");
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
  database: CatalogueStore,
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
    const child = await recoveryStatements
      .linkedRecoveryOperationStatement(database, { linkedOperationId })
      .first<{ id: string }>();
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
      const active = state.active_recovery_id === null ? null : await recoveryRow(database, state.active_recovery_id);
      if (active !== null && !["accepted", "failed"].includes(active.state)) {
        throw new AdministrationProblem(
          409,
          "recovery_exists",
          "Another Catalogue recovery operation is already active.",
        );
      }
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

async function startRecoveryRestore(database: CatalogueStore, recoveryId: string): Promise<void> {
  const result = await recoveryStatements.startRecoveryRestoreStatement(database, { recoveryId }).run();
  if (result.meta.changes !== 1) {
    throw new AdministrationProblem(409, "recovery_state_changed", "The recovery operation changed concurrently.");
  }
}

async function transitionToValidating(
  database: CatalogueStore,
  recoveryId: string,
  input: Readonly<{
    restoredBookmark: string;
    undoBookmark: string | null;
    restoredDatabaseId: string;
    retainedDatabaseId: string | null;
    observedAt: string;
  }>,
): Promise<void> {
  const result = await recoveryStatements
    .startRecoveryValidationStatement(database, {
      restoredBookmark: input.restoredBookmark,
      undoBookmark: input.undoBookmark,
      restoredDatabaseId: input.restoredDatabaseId,
      retainedDatabaseId: input.retainedDatabaseId,
      observedAt: input.observedAt,
      recoveryId,
    })
    .run();
  if (result.meta.changes !== 1) {
    throw new AdministrationProblem(409, "recovery_state_changed", "The recovery operation changed concurrently.");
  }
}

async function failRecovery(
  database: CatalogueStore,
  recoveryId: string,
  observedAt: string,
  code: string,
): Promise<void> {
  await recoveryStatements.failRecoveryOperationStatement(database, { code, observedAt, recoveryId }).run();
}

async function requiredRecovery(database: CatalogueStore, recoveryId: string): Promise<RecoveryRow> {
  assertOpaqueId(recoveryId, "recovery_id");
  const row = await recoveryRow(database, recoveryId);
  if (row === null) {
    throw new AdministrationProblem(404, "recovery_not_found", "Catalogue recovery operation not found.");
  }
  return row;
}

function recoveryRow(database: CatalogueStore, recoveryId: string): Promise<RecoveryRow | null> {
  return recoveryStatements.recoveryOperationByIdStatement(database, { recoveryId }).first<RecoveryRow>();
}

function recoveryByIdempotency(database: CatalogueStore, idempotencyKey: string): Promise<RecoveryRow | null> {
  return recoveryStatements.recoveryOperationByIdempotencyStatement(database, { idempotencyKey }).first<RecoveryRow>();
}

async function recoveryDocument(database: CatalogueStore, row: RecoveryRow): Promise<Record<string, unknown>> {
  return {
    contract: "card-keepr-catalogue-recovery@1",
    restored_work: (await recoveryStatements.restoredWorkClassificationsStatement(database, row.id).all()).results,
    restored_collections: (await recoveryStatements.restoredCollectionClassificationsStatement(database, row.id).all())
      .results,
    snapshot_scope:
      "Only operations present in the restored snapshot are retained; newer operations are not recovered.",
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
    verification:
      row.verification_json === null ? null : (JSON.parse(row.verification_json) as Record<string, unknown>),
    started_at: row.started_at,
    restored_at: row.restored_at,
    verified_at: row.verified_at,
    accepted_at: row.accepted_at,
    failure: row.state === "failed" ? { code: row.failure_code, detail: row.failure_detail } : null,
    operation_digest: await sha256Text(
      canonicalJson({
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
      }),
    ),
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

function activeProductionRelease(
  state: Readonly<{
    active_production_release_id: string | null;
    active_production_release_expires_at: string | null;
  }>,
  observedAt: string,
): boolean {
  return (
    state.active_production_release_id !== null &&
    state.active_production_release_expires_at !== null &&
    state.active_production_release_expires_at > observedAt
  );
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
    (input.method !== "time_travel" && input.method !== "replacement_database") ||
    input.targetBookmark.length === 0 ||
    !Number.isFinite(Date.parse(input.observedAt)) ||
    input.cloudflareAccountId.length === 0 ||
    input.catalogueDatabaseId.length === 0 ||
    input.verificationToken.length === 0
  ) {
    throw new AdministrationProblem(422, "invalid_recovery_request", "The recovery request is invalid.");
  }
}

function assertOpaqueId(value: string, name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value)) {
    throw new AdministrationProblem(422, "invalid_recovery_request", `${name} is invalid.`);
  }
}

function assertSha256(value: string, name: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new AdministrationProblem(422, "invalid_recovery_request", `${name} must be a lower-case SHA-256 digest.`);
  }
}

function validVerificationEvidence(value: unknown): value is CatalogueVerificationEvidence {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const evidence = value as Record<string, unknown>;
  const validCounts = [
    "cards",
    "printings",
    "products",
    "api_documents",
    "search_chunks",
    "provenance",
    "audit_rows",
  ].every((key) => Number.isSafeInteger(evidence[key]) && Number(evidence[key]) >= 0);
  const validRepresentativeDigests = ["representative_product_digest"].every(
    (key) =>
      !Object.hasOwn(evidence, key) ||
      evidence[key] === null ||
      (typeof evidence[key] === "string" && /^[a-f0-9]{64}$/u.test(evidence[key])),
  );
  return validCounts && validRepresentativeDigests;
}

function assertCompleteVerification(result: RestoredCatalogueVerification): void {
  if (
    result === null ||
    typeof result !== "object" ||
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
  )
    throw new Error("Restored Catalogue verification is incomplete.");
}

export const cloudflareD1RecoveryProvider: D1RecoveryProvider = {
  async currentBookmark(input) {
    const result = await cloudflareRequest(
      `/accounts/${encodeURIComponent(input.accountId)}/d1/database/${encodeURIComponent(
        input.databaseId,
      )}/time_travel/bookmark`,
      input.token,
      "GET",
    );
    return requiredString(result, "bookmark");
  },

  async timeTravelRestore(input) {
    const result = await cloudflareRequest(
      `/accounts/${encodeURIComponent(input.accountId)}/d1/database/${encodeURIComponent(
        input.databaseId,
      )}/time_travel/restore?bookmark=${encodeURIComponent(input.bookmark)}`,
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
  const response = await fetch(`https://api.cloudflare.com/client/v4${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
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
