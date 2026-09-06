import { verifiedRunCurrentSql } from "../shared";
import { runEventCommand, runEventIdentitySql, runEventStatement, runCompletedStageCount } from "../shared";
import {
  type CatalogueStore,
  ingestionRunTransitionSql,
  repositoryStatements,
  runTransitionGuardStatement,
} from "../shared";
// Named prepared statements; callers retain execution and atomic batch composition.

export function reservePublicationWriterStatement(
  database: CatalogueStore,
  input: Readonly<{
    approvalJson: string;
    idempotencyKey: string;
    progressJson: string;
    revisionId: string;
    startedAt: string;
    reconcileAfter: string;
    manifestDigest: string;
    writerToken: string;
    runId: string;
  }>,
): D1PreparedStatement {
  const event = runEventCommand("approval_reserved", { runId: input.runId, occurredAt: input.startedAt });
  const statement = repositoryStatements(database)
    .prepare(`UPDATE ingestion_run_current
      SET ${runEventIdentitySql}, state = 'publishing',
          approved_at = json_extract(?, '$.approved_at'),
          approved_candidate_digest = json_extract(?, '$.candidate_digest'),
          approved_expected_revision_id = json_extract(?, '$.expected_current_revision_id'),
          completed_stage_count = ?,
          publication_revision_id = ?,
          publication_started_at = ?,
          publication_reconcile_after = ?,
          publication_manifest_digest = ?,
          publication_writer_token = ?
      WHERE ingestion_run_id = ? AND ${ingestionRunTransitionSql("awaiting_approval", "publishing")}
      RETURNING ingestion_run_id AS id`)
    .bind(
      event.eventId,
      input.approvalJson,
      input.approvalJson,
      input.approvalJson,
      runCompletedStageCount(input.progressJson),
      input.revisionId,
      input.startedAt,
      input.reconcileAfter,
      input.manifestDigest,
      input.writerToken,
      input.runId,
    );
  return runEventStatement(database, {
    event,
    statement,
    approvalIdempotencyKey: input.idempotencyKey,
    decisionJson: input.approvalJson,
    guards: [
      runTransitionGuardStatement(database, { runId: input.runId, from: "awaiting_approval", to: "publishing" }),
    ],
  });
}

export function publicationWriterAuthorityStatement(
  database: CatalogueStore,
  input: Readonly<{ runId: string; includePublished: number; revisionId: string; writerToken: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT ingestion_run_id AS id
      FROM ingestion_run_current AS current
      WHERE ingestion_run_id = ?
        AND (
          state = 'publishing'
          OR (? = 1 AND state = 'published')
        )
        AND publication_revision_id = ?
        AND publication_writer_token = ? AND ${verifiedRunCurrentSql}`)
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
         SELECT 1 FROM ingestion_run_current
         WHERE ingestion_run_id <> ? AND publication_revision_id = ?
       ) AS other_run_reserved`)
    .bind(input.revisionId, input.revisionId, input.runId, input.revisionId);
}

export function nextPublicationToReconcileStatement(database: CatalogueStore, observedAt: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT *
      FROM ingestion_run_read
      WHERE state = 'publishing'
        AND publication_reconcile_after IS NOT NULL
        AND publication_reconcile_after <= ?
      ORDER BY publication_reconcile_after, id
      LIMIT 1`)
    .bind(observedAt);
}

export function catalogueRevisionDigestStatement(database: CatalogueStore, revisionId: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT content_digest
      FROM catalogue_revisions
      WHERE id = ?`)
    .bind(revisionId);
}
