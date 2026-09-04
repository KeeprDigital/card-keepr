import {
  type CatalogueVerificationQuery,
  catalogueVerificationQuery,
  catalogueVerificationStatement,
} from "./backup-verification-repository";
import * as backupStatements from "./backup-repository";
import {
  type BackupAttemptEvidenceRow,
  backupAttemptEvidenceStatement,
  restorePhaseTransitionStatement,
} from "./backup-repository";
import { AdministrationProblem, canonicalJson, sha256Text, StreamingSha256 } from "../shared";
import {
  prepareCardSearchForD1ExportStatements,
  reconstructCardSearchAfterD1RestoreStatements,
} from "./card-search-recovery-statements.ts";
import { completedCardSearchReconstructionQuery } from "./card-search-recovery-repository";
import { withCardSearchPreparedForD1Export } from "./card-search-recovery";
import { storedProductApiProjection } from "../read";
import { parseStoredLegalityRule } from "../legality";

export type D1BackupProvider = Readonly<{
  exportSql(
    input: Readonly<{
      accountId: string;
      databaseId: string;
      token: string;
    }>,
  ): Promise<{
    body: ReadableStream<Uint8Array>;
    size: number;
    bookmark: string;
    filename: string;
  }>;
  prepareRestoreTarget(
    input: Readonly<{
      accountId: string;
      configuredDatabaseId: string;
      token: string;
      attemptId: string;
      previousDatabaseId: string | null;
      generation: number;
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
      expectedRepresentativeDocuments?: CatalogueRepresentativeDocuments;
    }>,
  ): Promise<RestoredCatalogueVerification>;
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
  representative_product_digest?: string | null;
  representative_legality_rule_digest?: string | null;
  representative_search_text: string | null;
  representative_curated_revision_id: string | null;
  representative_curated_revision_digest: string | null;
  publication_ingestion_run_id: string | null;
}>;

export type CatalogueRepresentativeDocuments = Readonly<{
  representative_product_document_json: string | null;
  representative_legality_rule_document_json: string | null;
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

export async function publicationBackupReservation(catalogueRevisionId: string): Promise<PublicationBackupReservation> {
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

export async function catalogueBackupAttemptStatus(
  database: D1Database,
  idempotencyKey: string,
): Promise<Record<string, unknown>> {
  const attempt = await backupAttemptEvidenceRow(database, idempotencyKey);
  if (attempt === null) {
    throw new AdministrationProblem(404, "backup_not_found", "Backup attempt not found.");
  }
  const workflow = await backupStatements
    .backupWorkflowIdentityStatement(database, { idempotencyKey })
    .first<{ workflow_instance_id: string }>();
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
    failure: attempt.state === "failed" ? { code: attempt.failure_code, detail: attempt.failure_detail } : null,
    workflow_instance_id: workflow?.workflow_instance_id ?? null,
    resume:
      attempt.state === "pending" || isActiveAttemptState(attempt.state)
        ? {
            method: "POST",
            path: "/v1/backups",
            body: {
              ...(JSON.parse(attempt.request_json) as Record<string, unknown>),
              idempotency_key: attempt.idempotency_key,
            },
          }
        : null,
    retry:
      attempt.state === "failed"
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
  const known = await backupStatements
    .knownCatalogueRevisionStatement(database, { catalogueRevisionId })
    .first<{ present: number }>();
  if (known === null) {
    throw new AdministrationProblem(404, "catalogue_revision_not_found", "Catalogue Revision not found.");
  }
  const rows = await backupStatements
    .revisionBackupHistoryStatement(database, { catalogueRevisionId })
    .all<{ idempotency_key: string }>();
  return {
    contract: "card-keepr-catalogue-revision-backups@1",
    catalogue_revision_id: catalogueRevisionId,
    attempts: await Promise.all(rows.results.map((row) => catalogueBackupAttemptStatus(database, row.idempotency_key))),
  };
}

async function backupAttemptEvidenceRow(
  database: D1Database,
  idempotencyKey: string,
): Promise<BackupAttemptEvidenceRow | null> {
  return backupAttemptEvidenceStatement(database, idempotencyKey).first<BackupAttemptEvidenceRow>();
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
  if ((input.failedAttemptId === undefined) !== (input.failedAttemptDigest === undefined)) {
    throw new AdministrationProblem(
      422,
      "backup_retry_evidence_incomplete",
      "A backup retry requires both the exact failed attempt ID and digest.",
    );
  }
  if (input.failedAttemptId === undefined) {
    const retryRequired = await backupStatements
      .unrecoveredBackupFailureStatement(database, {
        expectedCurrentRevisionId: input.expectedCurrentRevisionId,
        idempotencyKey: input.idempotencyKey,
      })
      .first<{ required: number }>();
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
    throw new AdministrationProblem(409, "source_backup_not_failed", "The source backup attempt is not failed.");
  }
  const current = await backupStatements
    .backupCurrentRevisionStatement(database)
    .first<{ current_revision_id: string }>();
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
  const child = await backupStatements
    .backupRetryChildStatement(database, { idempotency_key: failed.idempotency_key })
    .first<{
      idempotency_key: string;
    }>();
  if (child !== null && child.idempotency_key !== input.idempotencyKey) {
    throw backupRetrySourceSuperseded();
  }
  if ((await backupAttemptDigest(failed)) !== input.failedAttemptDigest) {
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
  const objectPrefix = `d1-backups/${input.expectedCurrentRevisionId}/${digest}`;
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
  await backupStatements
    .insertPendingBackupStatement(database, {
      idempotencyKey: input.idempotencyKey,
      requestJson,
      ownerToken,
      expectedCurrentRevisionId: input.expectedCurrentRevisionId,
      objectKey,
      observedAt: input.observedAt,
      linkedAttemptId,
    })
    .run();
  const attempt = await backupStatements
    .backupAttemptWithRetentionStatement(database, { idempotencyKey: input.idempotencyKey })
    .first<{
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
    const winningChild = await backupStatements
      .linkedBackupAttemptStatement(database, { linkedAttemptId })
      .first<{ idempotency_key: string }>();
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
    attempt.state === "verified" &&
    attempt.d1_bookmark !== null &&
    attempt.manifest_key !== null &&
    attempt.content_sha256 !== null &&
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
    throw new AdministrationProblem(409, "backup_in_progress", "The retained backup attempt is already in progress.");
  }
  const publicationOwned = attempt.publication_ingestion_run_id !== null;
  const state = await backupStatements.backupOperationStateStatement(database).first<{
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
    throw new AdministrationProblem(409, "maintenance_not_idle", "Catalogue backup requires idle ingestion.");
  }
  const { expected: expectedVerification, representativeDocuments: expectedRepresentativeDocuments } =
    await captureCatalogueVerificationEvidenceWithDocuments(database, input.expectedCurrentRevisionId);
  let attemptState = attempt.state;
  if (attemptState === "pending") {
    try {
      await database.batch([
        backupStatements.guardPendingBackupStartStatement(database, {
          idempotencyKey: input.idempotencyKey,
          ownerToken,
          publicationOwned: publicationOwned ? 1 : 0,
        }),
        backupStatements.startBackupExportStatement(database, { idempotencyKey: input.idempotencyKey, ownerToken }),
        backupStatements.reserveBackupOperationStatement(database, { publicationOwned: publicationOwned ? 1 : 0 }),
      ]);
    } catch {
      throw new AdministrationProblem(
        409,
        "backup_in_progress",
        "Another Catalogue backup attempt is already in progress.",
      );
    }
    attemptState = "exporting";
  } else if (state.recovery_health !== (publicationOwned ? "degraded" : "blocked")) {
    throw new Error("The active backup attempt lost its recovery block.");
  }

  const leaseObservedAt = new Date(Math.max(Date.now(), Date.parse(input.observedAt))).toISOString();
  const leaseExpiresAt = new Date(Date.parse(leaseObservedAt) + 60 * 60 * 1000).toISOString();
  try {
    let bookmark = attempt.d1_bookmark;
    let exportBytes = attempt.export_bytes;
    let contentSha256 = attempt.content_sha256;
    let disposableDatabaseId = attempt.disposable_database_id;
    let restoreGeneration = attempt.restore_generation;
    const schemaMigrationLevel = attempt.schema_migration_level ?? (await currentSchemaMigrationLevel(database));
    if (attemptState === "exporting") {
      const existing = await backups.get(objectKey);
      let exportedBookmark: string;
      if (existing !== null) {
        exportedBookmark = existing.customMetadata?.d1_bookmark ?? "";
        if (
          existing.customMetadata?.catalogue_revision_id !== input.expectedCurrentRevisionId ||
          exportedBookmark.length === 0
        )
          throw new Error("Retained backup object evidence does not match the attempt.");
        const retainedEvidence = await digestRetainedObject(existing);
        contentSha256 = retainedEvidence.sha256;
        exportBytes = retainedEvidence.size;
      } else {
        await backupStatements.blockBackupRestoreStatement(database).run();
        let exported;
        try {
          exported = await withCardSearchPreparedForD1Export(
            database,
            { ownerToken, observedAt: leaseObservedAt, leaseExpiresAt },
            () =>
              provider.exportSql({
                accountId: input.cloudflareAccountId,
                databaseId: input.catalogueDatabaseId,
                token: input.exportToken,
              }),
          );
        } finally {
          await backupStatements.clearBackupRestoreStatement(database).run();
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
      await transitionRestorePhase(database, input.idempotencyKey, ownerToken, "prepared", "importing");
      await provider.restoreSql({
        accountId: input.cloudflareAccountId,
        databaseId: disposableDatabaseId,
        token: input.verificationToken,
        body: stored.body,
        size: stored.size,
        etag: stored.etag,
      });
      await transitionRestoredAttempt(database, input.idempotencyKey, ownerToken);
      attemptState = "verifying";
    }
    if (attemptState === "verifying") {
      if (
        disposableDatabaseId === null ||
        restoreGeneration < 1 ||
        (attempt.restore_phase !== "imported" && attemptState === attempt.state)
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
        expectedRepresentativeDocuments,
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
      if (existingManifest?.customMetadata?.manifest_sha256 !== manifestSha256)
        throw new Error("Immutable backup manifest already exists.");
    }
    try {
      await database.batch([
        backupStatements.guardBackupVerificationStatement(database, {
          idempotencyKey: input.idempotencyKey,
          ownerToken,
        }),
        backupStatements.completeBackupStatement(database, {
          bookmark,
          observedAt: input.observedAt,
          manifestKey,
          manifestSha256,
          idempotencyKey: input.idempotencyKey,
          ownerToken,
        }),
        backupStatements.datePreviousBackupRetentionStatement(database),
        backupStatements.retainNewestBackupStatement(database, { idempotencyKey: input.idempotencyKey }),
        backupStatements.restoreHealthyBackupStateStatement(database),
      ]);
    } catch {
      throw new AdministrationProblem(409, "backup_in_progress", "The backup attempt state changed concurrently.");
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
  return verifyRestoredCatalogueQueries(async (request) => {
    const result = await catalogueVerificationStatement(database, request).all<Record<string, unknown>>();
    return result.results;
  }, input);
}

export async function captureCatalogueVerificationEvidence(
  database: D1Database,
  revisionId: string,
): Promise<CatalogueVerificationEvidence> {
  return (await captureCatalogueVerificationEvidenceWithDocuments(database, revisionId)).expected;
}

async function captureCatalogueVerificationEvidenceWithDocuments(
  database: D1Database,
  revisionId: string,
): Promise<
  Readonly<{
    expected: CatalogueVerificationEvidence;
    representativeDocuments: CatalogueRepresentativeDocuments;
  }>
> {
  const row = await catalogueVerificationStatement(database, {
    kind: "evidence",
    revisionId,
    expectedJson: "capture",
  }).first<CatalogueVerificationEvidence & CatalogueRepresentativeDocuments>();
  if (row === null) throw new Error("Catalogue verification evidence is unavailable.");
  const expected = {
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
    representative_product_digest: await representativeDocumentDigest(row.representative_product_document_json),
    representative_legality_rule_digest: await representativeDocumentDigest(
      row.representative_legality_rule_document_json,
    ),
    representative_search_text: row.representative_search_text,
    representative_curated_revision_id: row.representative_curated_revision_id,
    representative_curated_revision_digest: row.representative_curated_revision_digest,
    publication_ingestion_run_id: row.publication_ingestion_run_id,
  };
  return {
    expected,
    representativeDocuments: {
      representative_product_document_json: row.representative_product_document_json,
      representative_legality_rule_document_json: row.representative_legality_rule_document_json,
    },
  };
}

type VerificationQuery = (request: CatalogueVerificationQuery) => Promise<Record<string, unknown>[]>;

async function verifyRestoredCatalogueQueries(
  query: VerificationQuery,
  input: Readonly<{
    expectedRevisionId: string;
    expectedSchemaMigrationLevel: number;
    expected: CatalogueVerificationEvidence;
    expectedRepresentativeDocuments?: CatalogueRepresentativeDocuments;
  }>,
): Promise<RestoredCatalogueVerification> {
  const [row] = await query({
    kind: "evidence",
    revisionId: input.expectedRevisionId,
    expectedJson: canonicalJson({ ...input.expected, ...input.expectedRepresentativeDocuments }),
  });
  const [integrity] = await query({ kind: "integrity" });
  const expected = input.expected;
  const apiRows =
    expected.representative_search_text === null || expected.representative_card_id === null
      ? []
      : await query({
          kind: "representative-card",
          revisionId: input.expectedRevisionId,
          representativeCardId: expected.representative_card_id,
          searchText: expected.representative_search_text,
        });
  let representativeDocuments = false;
  try {
    representativeDocuments = await validRepresentativeDocuments(row, expected, input.expectedRepresentativeDocuments);
  } catch {
    representativeDocuments = false;
  }
  const exactEvidence =
    row !== undefined &&
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
    row.representative_legality_rule_id === expected.representative_legality_rule_id &&
    row.representative_curated_revision_id === expected.representative_curated_revision_id &&
    row.representative_curated_revision_digest === expected.representative_curated_revision_digest &&
    row.publication_ingestion_run_id === expected.publication_ingestion_run_id;
  const cardEvidence =
    expected.cards === 0
      ? expected.api_documents === 0 &&
        expected.search_terms === 0 &&
        expected.search_chunks === 0 &&
        expected.representative_card_id === null &&
        expected.representative_search_text === null
      : expected.api_documents > 0 &&
        expected.search_terms > 0 &&
        expected.search_chunks > 0 &&
        [expected.representative_card_id, expected.representative_search_text].every(
          (value) => typeof value === "string" && value.length > 0,
        );
  const printingEvidence =
    expected.printings === 0
      ? expected.representative_printing_id === null
      : typeof expected.representative_printing_id === "string" && expected.representative_printing_id.length > 0;
  const nonVacuous =
    expected.cards + expected.products + expected.legality_rules > 0 &&
    expected.audit_rows > 0 &&
    cardEvidence &&
    printingEvidence &&
    typeof expected.publication_ingestion_run_id === "string" &&
    expected.publication_ingestion_run_id.length > 0 &&
    (expected.products === 0
      ? expected.representative_product_id === null
      : typeof expected.representative_product_id === "string" && expected.representative_product_id.length > 0) &&
    (expected.legality_rules === 0
      ? expected.representative_legality_rule_id === null
      : typeof expected.representative_legality_rule_id === "string" &&
        expected.representative_legality_rule_id.length > 0) &&
    (expected.provenance === 0
      ? expected.representative_curated_revision_id === null && expected.representative_curated_revision_digest === null
      : typeof expected.representative_curated_revision_id === "string" &&
        typeof expected.representative_curated_revision_digest === "string");
  const apiEvidence =
    expected.cards === 0
      ? apiRows.length === 0
      : apiRows.length > 0 &&
        apiRows.every(validApiCardRow) &&
        apiRows.some((apiRow) => apiCardId(apiRow) === expected.representative_card_id);
  if (integrity?.quick_check !== "ok" || !exactEvidence || !nonVacuous || !apiEvidence || !representativeDocuments)
    throw new Error("Restored D1 verification failed.");
  return completeRestoredVerification();
}

async function validRepresentativeDocuments(
  row: Record<string, unknown> | undefined,
  expected: CatalogueVerificationEvidence,
  sourceDocuments?: CatalogueRepresentativeDocuments,
): Promise<boolean> {
  if (row === undefined) return false;
  const productDocument = nullableDocumentJson(row.representative_product_document_json);
  const legalityRuleDocument = nullableDocumentJson(row.representative_legality_rule_document_json);
  if (
    sourceDocuments !== undefined &&
    (productDocument !== sourceDocuments.representative_product_document_json ||
      legalityRuleDocument !== sourceDocuments.representative_legality_rule_document_json)
  )
    return false;
  if (expected.representative_product_id === null) {
    if (productDocument !== null) return false;
  } else {
    if (productDocument === null) return false;
    if (storedProductApiProjection(productDocument).id !== expected.representative_product_id) return false;
  }
  if (expected.representative_legality_rule_id === null) {
    if (legalityRuleDocument !== null) return false;
  } else {
    if (legalityRuleDocument === null) return false;
    if (parseStoredLegalityRule(legalityRuleDocument).id !== expected.representative_legality_rule_id) return false;
  }
  return (
    (await representativeDigestMatches(expected, "representative_product_digest", productDocument)) &&
    (await representativeDigestMatches(expected, "representative_legality_rule_digest", legalityRuleDocument))
  );
}

function nullableDocumentJson(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error("Representative restore document is unavailable.");
  }
  return value;
}

async function representativeDigestMatches(
  expected: CatalogueVerificationEvidence,
  key: "representative_product_digest" | "representative_legality_rule_digest",
  documentJson: string | null,
): Promise<boolean> {
  if (!Object.prototype.hasOwnProperty.call(expected, key)) return true;
  const digest = expected[key];
  if (digest === null) return documentJson === null;
  return (
    typeof digest === "string" &&
    /^[a-f0-9]{64}$/u.test(digest) &&
    documentJson !== null &&
    (await sha256Text(documentJson)) === digest
  );
}

async function representativeDocumentDigest(documentJson: string | null): Promise<string | null> {
  return documentJson === null ? null : sha256Text(documentJson);
}

export const cloudflareD1BackupProvider: D1BackupProvider = {
  async exportSql(input) {
    const pathname = d1Path(input.accountId, input.databaseId, "export");
    let bookmark: string | undefined;
    for (let attempt = 0; attempt < 1_200; attempt += 1) {
      const result = await cloudflareD1Request(pathname, input.token, {
        output_format: "polling",
        ...(bookmark === undefined ? {} : { current_bookmark: bookmark }),
      });
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
    const collectionPath = `/accounts/${encodeURIComponent(input.accountId)}/d1/database`;
    const listed = await cloudflareD1ManagementRequest(
      `${collectionPath}?name=${encodeURIComponent("card-keepr-disposable-verification")}`,
      input.token,
      "GET",
    );
    if (!Array.isArray(listed)) {
      throw new Error("Disposable D1 database inventory is invalid.");
    }
    const databaseIds = new Set<string>();
    for (const entry of listed) {
      if (isRecord(entry) && typeof entry.uuid === "string") {
        databaseIds.add(entry.uuid);
      }
    }
    if (input.previousDatabaseId !== null) {
      databaseIds.add(input.previousDatabaseId);
    }
    if (input.generation === 1) {
      databaseIds.add(input.configuredDatabaseId);
    }
    for (const databaseId of databaseIds) {
      await deleteCloudflareD1Database(input.accountId, databaseId, input.token);
    }
    const created = await cloudflareD1ManagementRequest(collectionPath, input.token, "POST", {
      name: "card-keepr-disposable-verification",
    });
    if (!isRecord(created)) {
      throw new Error("Disposable D1 database creation response is invalid.");
    }
    return { databaseId: requiredString(created.uuid, "database identity") };
  },

  async restoreSql(input) {
    const pathname = d1Path(input.accountId, input.databaseId, "import");
    const etag = input.etag.replaceAll('"', "");
    const initialized = await cloudflareD1Request(pathname, input.token, { action: "init", etag });
    const uploadUrl = requiredString(initialized.upload_url, "upload URL");
    const filename = requiredString(initialized.filename, "filename");
    const uploaded = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "content-length": String(input.size) },
      body: input.body,
    });
    if (!uploaded.ok || uploaded.headers.get("etag")?.replaceAll('"', "") !== etag) {
      throw new Error("D1 restore upload failed.");
    }
    let result = await cloudflareD1Request(pathname, input.token, { action: "ingest", etag, filename });
    for (let attempt = 0; attempt < 1_200; attempt += 1) {
      if (result.status === "error") {
        throw new Error(`D1 restore failed: ${String(result.error)}`);
      }
      if (result.status === "complete") return;
      result = await cloudflareD1Request(pathname, input.token, {
        action: "poll",
        current_bookmark: requiredString(result.at_bookmark, "bookmark"),
      });
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
    await cloudflareD1Request(pathname, input.token, completedCardSearchReconstructionQuery(input.ownerToken));
    return verifyRestoredCatalogueQueries(
      async (request) =>
        queryRows(await cloudflareD1Request(pathname, input.token, catalogueVerificationQuery(request))),
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
    result?: unknown;
  }>();
  if (!response.ok || envelope.success !== true) {
    throw new Error("Cloudflare D1 management operation failed.");
  }
  return envelope.result;
}

async function deleteCloudflareD1Database(accountId: string, databaseId: string, token: string): Promise<void> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
      accountId,
    )}/d1/database/${encodeURIComponent(databaseId)}`,
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
  const response = await fetch(`https://api.cloudflare.com/client/v4${pathname}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
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
      envelope.result.some(
        (query) => query === null || typeof query !== "object" || (query as { success?: unknown }).success !== true,
      ))
  ) {
    throw new Error("Cloudflare D1 query failed.");
  }
  return envelope.result;
}

function backupDocument(
  attempt: Readonly<{
    catalogue_revision_id: string;
    object_key: string;
    d1_bookmark: string;
    content_sha256: string;
    manifest_key: string;
    manifest_sha256: string;
    linked_attempt_id: string | null;
    newest_success: boolean;
    retain_until: string | null;
  }>,
): CatalogueBackupDocument {
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
  const changed = await backupStatements
    .prepareBackupRestoreTargetStatement(database, {
      disposableDatabaseId,
      nextGeneration,
      idempotencyKey,
      ownerToken,
      previousGeneration,
    })
    .run();
  if (changed.meta.changes !== 1) {
    throw new AdministrationProblem(409, "backup_in_progress", "The disposable restore target changed concurrently.");
  }
}

async function transitionRestorePhase(
  database: D1Database,
  idempotencyKey: string,
  ownerToken: string,
  from: string,
  to: string,
): Promise<void> {
  const changed = await restorePhaseTransitionStatement(database, { idempotencyKey, ownerToken, from, to }).run();
  if (changed.meta.changes !== 1) {
    throw new AdministrationProblem(409, "backup_in_progress", "The disposable restore phase changed concurrently.");
  }
}

async function transitionRestoredAttempt(
  database: D1Database,
  idempotencyKey: string,
  ownerToken: string,
): Promise<void> {
  const changed = await backupStatements
    .startBackupVerificationStatement(database, { idempotencyKey, ownerToken })
    .run();
  if (changed.meta.changes !== 1) {
    throw new AdministrationProblem(409, "backup_in_progress", "The restored backup attempt changed concurrently.");
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
  const changed = await backupStatements
    .completeBackupExportStatement(database, {
      bookmark,
      contentSha256,
      exportBytes,
      schemaMigrationLevel,
      idempotencyKey,
      ownerToken,
    })
    .run();
  if (changed.meta.changes !== 1) {
    throw new AdministrationProblem(409, "backup_in_progress", "The backup attempt state changed concurrently.");
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
    backupStatements.degradeActiveBackupStateStatement(database, { idempotencyKey, ownerToken }),
    backupStatements.failOwnedActiveBackupStatement(database, { detail, completedAt, idempotencyKey, ownerToken }),
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
  await backupStatements
    .failOwnedBackupStatement(database, { code, detail, completedAt, idempotencyKey, ownerToken })
    .run();
}

function d1Path(accountId: string, databaseId: string, action: string): string {
  return `/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/${action}`;
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
  const results = query !== null && typeof query === "object" ? (query as { results?: unknown }).results : null;
  if (!Array.isArray(results)) {
    throw new Error("Restored D1 verification response is invalid.");
  }
  if (results.some((row) => row === null || typeof row !== "object" || Array.isArray(row))) {
    throw new Error("Restored D1 verification response is invalid.");
  }
  return results as Record<string, unknown>[];
}

function validApiCardRow(row: Record<string, unknown>): boolean {
  return [row.sort_game, row.sort_identity_kind, row.sort_identity_value, row.summary_json].every(
    (value) => typeof value === "string",
  );
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

async function digestRetainedObject(object: R2ObjectBody): Promise<{ sha256: string; size: number }> {
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

function assertCompleteRestoredVerification(result: RestoredCatalogueVerification): void {
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
  return ["pending", "exporting", "restoring_verification", "verifying"].includes(value);
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
    (input.failedAttemptDigest !== undefined && !/^[a-f0-9]{64}$/u.test(input.failedAttemptDigest))
  ) {
    throw new Error("Catalogue backup input is invalid.");
  }
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function currentSchemaMigrationLevel(database: D1Database): Promise<number> {
  const row = await backupStatements.backupSchemaMigrationLevelStatement(database).first<{ migration_level: number }>();
  if (!Number.isSafeInteger(row?.migration_level) || row!.migration_level <= 0) {
    throw new Error("The Catalogue schema migration level is unavailable.");
  }
  return row!.migration_level;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
