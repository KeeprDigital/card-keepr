import { type CatalogueStore, ingestionRunTransitionSql, repositoryStatements } from "../shared";
// Named prepared statements; callers retain execution and atomic batch composition.

export function reservePublicationWriterStatement(
  database: CatalogueStore,
  input: Readonly<{
    approvalJson: string;
    idempotencyKey: string;
    approvalHistoryJson: string;
    progressJson: string;
    revisionId: string;
    startedAt: string;
    reconcileAfter: string;
    manifestDigest: string;
    writerToken: string;
    runId: string;
  }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE ingestion_runs
      SET state = 'publishing',
          approval_json = ?,
          approval_idempotency_key = ?,
          approval_history_json = ?,
          progress_json = ?,
          publication_revision_id = ?,
          publication_started_at = ?,
          publication_reconcile_after = ?,
          publication_manifest_digest = ?,
          publication_writer_token = ?
      WHERE id = ? AND ${ingestionRunTransitionSql("awaiting_approval", "publishing")}
      RETURNING id`)
    .bind(
      input.approvalJson,
      input.idempotencyKey,
      input.approvalHistoryJson,
      input.progressJson,
      input.revisionId,
      input.startedAt,
      input.reconcileAfter,
      input.manifestDigest,
      input.writerToken,
      input.runId,
    );
}

export function publicationWriterAuthorityStatement(
  database: CatalogueStore,
  input: Readonly<{ runId: string; includePublished: number; revisionId: string; writerToken: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT id
      FROM ingestion_runs
      WHERE id = ?
        AND (
          state = 'publishing'
          OR (? = 1 AND state = 'published')
        )
        AND publication_revision_id = ?
        AND publication_writer_token = ?`)
    .bind(input.runId, input.includePublished, input.revisionId, input.writerToken);
}

export function recordLatePublicationObjectStatement(
  database: CatalogueStore,
  input: Readonly<{ runId: string; objectKey: string; failedAt: string; notBefore: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`INSERT INTO ingestion_publication_cleanup (
        ingestion_run_id,
        state,
        object_keys_json,
        attempts,
        failure_code,
        last_attempt_at,
        completed_at,
        not_before,
        idempotency_key,
        request_json,
        claim_token,
        claim_version,
        claim_expires_at
      ) VALUES (
        ?, 'failed', json_array(?), 1,
        'late_publication_write', ?, NULL, ?,
        NULL, NULL, NULL, 1, NULL
      )
      ON CONFLICT (ingestion_run_id) DO UPDATE SET
        state = 'failed',
        object_keys_json = (
          SELECT json_group_array(object_key)
          FROM (
            SELECT value AS object_key
            FROM json_each(
              ingestion_publication_cleanup.object_keys_json
            )
            UNION
            SELECT excluded_key.object_key
            FROM (SELECT ? AS object_key) AS excluded_key
            ORDER BY object_key
          )
        ),
        attempts = MAX(ingestion_publication_cleanup.attempts, 1),
        failure_code = 'late_publication_write',
        last_attempt_at = ?,
        completed_at = NULL,
        idempotency_key = NULL,
        request_json = NULL,
        claim_token = NULL,
        claim_version =
          ingestion_publication_cleanup.claim_version + 1,
        claim_expires_at = NULL`)
    .bind(input.runId, input.objectKey, input.failedAt, input.notBefore, input.objectKey, input.failedAt);
}

export function publicationRegistrationStateStatement(
  database: CatalogueStore,
  input: Readonly<{ revisionId: string; runId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT
       EXISTS(
         SELECT 1 FROM catalogue_revisions WHERE id = ?
       ) AS revision_registered,
       EXISTS(
         SELECT 1 FROM catalogue_exports
         WHERE catalogue_revision_id = ?
       ) AS export_registered,
       EXISTS(
         SELECT 1 FROM ingestion_runs
         WHERE id <> ? AND publication_revision_id = ?
       ) AS other_run_reserved`)
    .bind(input.revisionId, input.revisionId, input.runId, input.revisionId);
}

export function nextPublicationToReconcileStatement(database: CatalogueStore, observedAt: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT *
      FROM ingestion_runs
      WHERE state = 'publishing'
        AND publication_reconcile_after IS NOT NULL
        AND publication_reconcile_after <= ?
      ORDER BY publication_reconcile_after, id
      LIMIT 1`)
    .bind(observedAt);
}

export function candidateLegalityEvidenceStatement(database: CatalogueStore, ruleIdsJson: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT id, source_lineage, source_snapshot_id,
              source_observation_set_id, source_observation_id,
              source_observation_pointer, source_field_pointers_json
       FROM legality_rules
       WHERE id IN (SELECT value FROM json_each(?))`)
    .bind(ruleIdsJson);
}

export function catalogueRevisionDigestStatement(database: CatalogueStore, revisionId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT content_digest
      FROM catalogue_revisions
      WHERE id = ?`)
    .bind(revisionId);
}
