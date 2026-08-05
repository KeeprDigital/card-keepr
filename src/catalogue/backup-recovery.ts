import { AdministrationProblem } from "./administration-problem.mjs";
import {
  prepareCardSearchForD1ExportStatements,
  reconstructCardSearchAfterD1RestoreStatements,
} from "./card-search-recovery-statements.mjs";
import {
  withCardSearchPreparedForD1Export,
} from "./card-search-recovery";
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
  }>): Promise<RestoredCatalogueVerification>;
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
  });
  const linkedAttempt = await database.prepare(
    `SELECT idempotency_key FROM catalogue_backup_attempts
     WHERE catalogue_revision_id = ? AND state = 'failed'
     ORDER BY completed_at DESC, idempotency_key DESC LIMIT 1`,
  ).bind(input.expectedCurrentRevisionId).first<{ idempotency_key: string }>();
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
    linkedAttempt?.idempotency_key ?? null,
  ).run();
  const attempt = await database.prepare(
    `SELECT request_json, state, catalogue_revision_id, object_key,
            d1_bookmark, failure_code, failure_detail, manifest_key,
            content_sha256, manifest_sha256, export_bytes,
            schema_migration_level, linked_attempt_id,
            publication_ingestion_run_id, retention.newest_success,
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
    newest_success: number | null;
    retain_until: string | null;
  }>();
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
    const schemaMigrationLevel = attempt.schema_migration_level ??
      await currentSchemaMigrationLevel(database);
    if (attemptState === "exporting") {
      const exported = await withCardSearchPreparedForD1Export(
        database,
        { ownerToken, observedAt: leaseObservedAt, leaseExpiresAt },
        () => provider.exportSql({
          accountId: input.cloudflareAccountId,
          databaseId: input.catalogueDatabaseId,
          token: input.exportToken,
        }),
      );
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
      await transitionExportedAttempt(
        database,
        input.idempotencyKey,
        ownerToken,
        exported.bookmark,
        contentSha256,
        exportBytes,
        schemaMigrationLevel,
      );
      bookmark = exported.bookmark;
      attemptState = "restoring_verification";
    }
    if (bookmark === null) {
      throw new Error("The retained D1 export bookmark is unavailable.");
    }
    if (contentSha256 === null || exportBytes === null) {
      throw new Error("The retained D1 export evidence is unavailable.");
    }
    if (attemptState === "restoring_verification") {
      const stored = await backups.get(objectKey);
      if (stored === null) throw new Error("Retained backup is unavailable.");
      await provider.restoreSql({
        accountId: input.cloudflareAccountId,
        databaseId: input.disposableDatabaseId,
        token: input.verificationToken,
        body: stored.body,
        size: stored.size,
        etag: stored.etag,
      });
      await transitionAttempt(
        database,
        input.idempotencyKey,
        ownerToken,
        "restoring_verification",
        "verifying",
      );
      attemptState = "verifying";
    }
    if (attemptState === "verifying") {
      const restoredVerification = await provider.reconstructAndVerify({
        accountId: input.cloudflareAccountId,
        databaseId: input.disposableDatabaseId,
        token: input.verificationToken,
        ownerToken,
        expectedRevisionId: input.expectedCurrentRevisionId,
        expectedSchemaMigrationLevel: schemaMigrationLevel,
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
      verification: {
        disposable_database_id: input.disposableDatabaseId,
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
               manifest_key = ?, manifest_sha256 = ?
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

const cloudflareD1BackupProvider: D1BackupProvider = {
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
    const verification = await cloudflareD1Request(
      pathname,
      input.token,
      {
        sql:
          `SELECT catalogue.current_revision_id,
                  schema_state.migration_level AS schema_migration_level,
                  search.state AS card_search_state,
                  (SELECT count(*) FROM sqlite_schema
                   WHERE type = 'table'
                     AND name = 'revision_card_search_fts'
                     AND lower(sql) LIKE '%create virtual table%')
                    AS card_search_fts_tables,
                  (SELECT count(*) FROM revision_card_search_chunks AS chunk
                   LEFT JOIN revision_card_search_fts_rows AS mapped USING (
                     catalogue_revision_id, card_id, field_ordinal, chunk_ordinal
                   ) WHERE mapped.fts_rowid IS NULL) AS missing_fts_rows,
                  (SELECT count(*) FROM revision_card_query_documents
                   WHERE json_valid(summary_json) = 0) AS invalid_api_documents,
                  (SELECT count(*) FROM revision_card_query_documents
                   WHERE catalogue_revision_id = catalogue.current_revision_id)
                    AS current_api_documents,
                  (SELECT count(*) FROM revision_cards
                   WHERE catalogue_revision_id = catalogue.current_revision_id)
                    AS current_cards,
                  (SELECT count(*) FROM revision_printings
                   WHERE catalogue_revision_id = catalogue.current_revision_id)
                    AS current_printings,
                  (SELECT count(*) FROM revision_products
                   WHERE catalogue_revision_id = catalogue.current_revision_id)
                    AS current_products,
                  (SELECT count(*) FROM revision_legality_rules
                   WHERE catalogue_revision_id = catalogue.current_revision_id)
                    AS current_legality_rules,
                  (SELECT count(*) FROM catalogue_curated_provenance
                   WHERE json_valid(provenance_json) = 0)
                    AS invalid_curated_provenance,
                  (SELECT count(*) FROM ingestion_runs
                   WHERE json_valid(progress_json) = 0)
                    AS invalid_audit_rows
           FROM catalogue_state AS catalogue
           JOIN card_search_fts_state AS search ON search.singleton = 1
           JOIN catalogue_schema_state AS schema_state
             ON schema_state.singleton = 1
           WHERE catalogue.singleton = 1
             AND catalogue.current_revision_id = ?`,
        params: [input.expectedRevisionId],
      },
    );
    const integrity = firstQueryRow(await cloudflareD1Request(
      pathname,
      input.token,
      { sql: "PRAGMA quick_check" },
    ));
    const apiRows = queryRows(await cloudflareD1Request(
      pathname,
      input.token,
      {
        sql:
          `SELECT card_id, game_id, card_number, summary_json
           FROM revision_card_query_documents
           WHERE catalogue_revision_id = ?
           ORDER BY game_id, card_number, card_id LIMIT 1`,
        params: [input.expectedRevisionId],
      },
    ));
    const row = firstQueryRow(verification);
    if (
      integrity.quick_check !== "ok" ||
      row.schema_migration_level !== input.expectedSchemaMigrationLevel ||
      row.current_revision_id !== input.expectedRevisionId ||
      row.card_search_state !== "ready" ||
      row.card_search_fts_tables !== 1 ||
      row.missing_fts_rows !== 0 ||
      row.invalid_api_documents !== 0 ||
      row.invalid_curated_provenance !== 0 ||
      row.invalid_audit_rows !== 0 ||
      typeof row.current_api_documents !== "number" ||
      typeof row.current_cards !== "number" ||
      typeof row.current_printings !== "number" ||
      typeof row.current_products !== "number" ||
      typeof row.current_legality_rules !== "number" ||
      row.current_api_documents !== row.current_cards ||
      !apiRows.every(validApiCardRow)
    ) {
      throw new Error("Restored D1 verification failed.");
    }
    return completeRestoredVerification();
  },
};

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

async function transitionAttempt(
  database: D1Database,
  idempotencyKey: string,
  ownerToken: string,
  from: string,
  to: string,
): Promise<void> {
  const changed = await database.prepare(
    `UPDATE catalogue_backup_attempts SET state = ?
     WHERE idempotency_key = ? AND owner_token = ? AND state = ?`,
  ).bind(to, idempotencyKey, ownerToken, from).run();
  if (changed.meta.changes !== 1) {
    throw new AdministrationProblem(
      409,
      "backup_in_progress",
      "The backup attempt state changed concurrently.",
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
  return [row.card_id, row.game_id, row.card_number, row.summary_json]
    .every((value) => typeof value === "string");
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
    input.verificationToken.length === 0
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
