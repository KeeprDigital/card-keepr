import { ingestionRunTransitionSql } from "../shared";
// Named prepared statements; callers retain execution and atomic batch composition.

export function recordNoChangeResultStatement(
  database: D1Database,
  input: Readonly<{ runId: string; revisionId: string; candidateDigest: string; checkedAt: string }>,
): D1PreparedStatement {
  return database
    .prepare(`INSERT INTO ingestion_no_change_results (
            ingestion_run_id,
            catalogue_revision_id,
            candidate_digest,
            checked_at
          ) VALUES (?, ?, ?, ?)`)
    .bind(input.runId, input.revisionId, input.candidateDigest, input.checkedAt);
}

export function approveNoChangeRunStatement(
  database: D1Database,
  input: Readonly<{
    approvalJson: string;
    idempotencyKey: string;
    approvalHistoryJson: string;
    progressJson: string;
    runId: string;
  }>,
): D1PreparedStatement {
  return database
    .prepare(`UPDATE ingestion_runs
          SET state = 'publishing',
              approval_json = ?,
              approval_idempotency_key = ?,
              approval_history_json = ?,
              progress_json = ?
          WHERE id = ? AND ${ingestionRunTransitionSql("awaiting_approval", "publishing")}`)
    .bind(input.approvalJson, input.idempotencyKey, input.approvalHistoryJson, input.progressJson, input.runId);
}

export function publishNoChangeRunStatement(
  database: D1Database,
  input: Readonly<{ terminalAt: string; progressJson: string; revisionId: string; checkedAt: string; runId: string }>,
): D1PreparedStatement {
  return database
    .prepare(`UPDATE ingestion_runs
          SET state = 'published',
              terminal_at = ?,
              progress_json = ?,
              publication_outcome = 'no_change',
              resulting_revision_id = ?,
              freshness_checked_at = ?
          WHERE id = ? AND ${ingestionRunTransitionSql("publishing", "published")}`)
    .bind(input.terminalAt, input.progressJson, input.revisionId, input.checkedAt, input.runId);
}

export function publishCardDocumentsStatement(
  database: D1Database,
  input: Readonly<{ revisionId: string; documentsJson: string }>,
): D1PreparedStatement {
  return database
    .prepare(`INSERT INTO revision_cards (
           catalogue_revision_id, card_id, document_json
         )
         SELECT ?, json_extract(value, '$.card_id'),
                json_extract(value, '$.document_json')
         FROM json_each(?)`)
    .bind(input.revisionId, input.documentsJson);
}

export function publishCardQueryDocumentsStatement(
  database: D1Database,
  input: Readonly<{ revisionId: string; documentsJson: string }>,
): D1PreparedStatement {
  return database
    .prepare(`INSERT INTO revision_card_query_documents (
           catalogue_revision_id, card_id, summary_json, search_text
         )
         SELECT ?, json_extract(value, '$.card_id'),
                json_extract(value, '$.summary_json'),
                json_extract(value, '$.search_text')
         FROM json_each(?)`)
    .bind(input.revisionId, input.documentsJson);
}

export function publishCardSearchTermsStatement(
  database: D1Database,
  input: Readonly<{ termsJson: string; revisionId: string }>,
): D1PreparedStatement {
  return database
    .prepare(`INSERT INTO revision_card_search_terms (
           catalogue_revision_id, card_id, term, sort_game,
           sort_identity_kind, sort_identity_value, sort_id
         )
         SELECT query.catalogue_revision_id, query.card_id,
                json_extract(term.value, '$.term'),
                query.sort_game, query.sort_identity_kind,
                query.sort_identity_value, query.sort_id
         FROM json_each(?) AS term
         JOIN revision_card_query_documents AS query
           ON query.catalogue_revision_id = ?
          AND query.card_id = json_extract(term.value, '$.card_id')`)
    .bind(input.termsJson, input.revisionId);
}

export function publishCardSearchChunksStatement(
  database: D1Database,
  input: Readonly<{ revisionId: string; chunksJson: string }>,
): D1PreparedStatement {
  return database
    .prepare(`INSERT INTO revision_card_search_chunks (
           catalogue_revision_id, card_id, field_ordinal,
           chunk_ordinal, search_text
         )
         SELECT ?, json_extract(value, '$.card_id'),
                json_extract(value, '$.field_ordinal'),
                json_extract(value, '$.chunk_ordinal'),
                json_extract(value, '$.search_text')
         FROM json_each(?)`)
    .bind(input.revisionId, input.chunksJson);
}

export function publishPrintingDocumentsStatement(
  database: D1Database,
  input: Readonly<{ revisionId: string; documentsJson: string }>,
): D1PreparedStatement {
  return database
    .prepare(`INSERT INTO revision_printings (
           catalogue_revision_id, printing_id, card_id, document_json
         )
         SELECT ?, json_extract(value, '$.printing_id'),
                json_extract(value, '$.card_id'),
                json_extract(value, '$.document_json')
         FROM json_each(?)`)
    .bind(input.revisionId, input.documentsJson);
}

export function publishReconciledPrintingImagesStatement(
  database: D1Database,
  imagesJson: string,
): D1PreparedStatement {
  return database
    .prepare(`INSERT INTO reconciled_printing_images (
           id, printing_id, role, media_type, width, height,
           content_sha256, content_byte_length, object_key
         )
         SELECT
           json_extract(value, '$.id'),
           json_extract(value, '$.printing_id'),
           json_extract(value, '$.role'),
           json_extract(value, '$.media_type'),
           json_extract(value, '$.width'),
           json_extract(value, '$.height'),
           json_extract(value, '$.content_sha256'),
           json_extract(value, '$.content_byte_length'),
           json_extract(value, '$.object_key')
         FROM json_each(?)
         WHERE true
         ON CONFLICT(id) DO UPDATE SET
           printing_id = excluded.printing_id,
           role = excluded.role,
           media_type = excluded.media_type,
           width = excluded.width,
           height = excluded.height,
           content_sha256 = excluded.content_sha256,
           content_byte_length = excluded.content_byte_length,
           object_key = excluded.object_key`)
    .bind(imagesJson);
}

export function publishRevisionPrintingImagesStatement(
  database: D1Database,
  input: Readonly<{ revisionId: string; imagesJson: string }>,
): D1PreparedStatement {
  return database
    .prepare(`INSERT INTO revision_printing_images (
           catalogue_revision_id, image_id, printing_id,
           media_type, content_sha256, content_byte_length, object_key
         )
         SELECT ?,
           json_extract(value, '$.image_id'),
           json_extract(value, '$.printing_id'),
           json_extract(value, '$.media_type'),
           json_extract(value, '$.content_sha256'),
           json_extract(value, '$.content_byte_length'),
           json_extract(value, '$.object_key')
         FROM json_each(?)`)
    .bind(input.revisionId, input.imagesJson);
}

export function registerCatalogueRevisionStatement(
  database: D1Database,
  input: Readonly<{
    revisionId: string;
    runId: string;
    publishedAt: string;
    contentDigest: string;
    expectedRevisionId: string;
    candidateDigest: string | null;
  }>,
): D1PreparedStatement {
  return database
    .prepare(`INSERT INTO catalogue_revisions (
          id,
          ingestion_run_id,
          published_at,
          content_digest,
          expected_previous_revision_id,
          approved_candidate_digest
        ) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(
      input.revisionId,
      input.runId,
      input.publishedAt,
      input.contentDigest,
      input.expectedRevisionId,
      input.candidateDigest,
    );
}

export function registerAvailableQueryRevisionStatement(database: D1Database, revisionId: string): D1PreparedStatement {
  return database
    .prepare(`INSERT INTO catalogue_query_revisions (
           catalogue_revision_id, state, repaired_through_card_id
         ) VALUES (?, 'available', NULL)`)
    .bind(revisionId);
}

export function archiveOldQueryRevisionsStatement(database: D1Database, revisionId: string): D1PreparedStatement {
  return database
    .prepare(`WITH RECURSIVE retained(catalogue_revision_id, depth) AS (
         SELECT ?, 0
         UNION ALL
         SELECT revision.expected_previous_revision_id, retained.depth + 1
         FROM retained
         JOIN catalogue_revisions AS revision
           ON revision.id = retained.catalogue_revision_id
         WHERE retained.depth < 2
           AND revision.expected_previous_revision_id IS NOT NULL
       )
       UPDATE catalogue_query_revisions
       SET state = 'archived',
           repaired_through_card_id = NULL,
           repair_card_id = NULL,
           repair_search_offset = 0,
           repair_term_offset = 0
       WHERE catalogue_revision_id NOT IN (
         SELECT catalogue_revision_id
         FROM retained
       )`)
    .bind(revisionId);
}

export function deleteArchivedCardQueryDocumentsStatement(database: D1Database): D1PreparedStatement {
  return database.prepare(`DELETE FROM revision_card_query_documents
       WHERE catalogue_revision_id IN (
         SELECT catalogue_revision_id
         FROM catalogue_query_revisions
         WHERE state = 'archived'
       )`);
}

export function registerVerifiedCatalogueExportStatement(
  database: D1Database,
  input: Readonly<{ revisionId: string; manifestKey: string; manifestDigest: string }>,
): D1PreparedStatement {
  return database
    .prepare(`INSERT INTO catalogue_exports (
          catalogue_revision_id,
          manifest_key,
          manifest_digest,
          verified
        ) VALUES (?, ?, ?, 1)`)
    .bind(input.revisionId, input.manifestKey, input.manifestDigest);
}

export function advanceCatalogueRevisionStatement(
  database: D1Database,
  input: Readonly<{ revisionId: string; publishedAt: string; expectedRevisionId: string }>,
): D1PreparedStatement {
  return database
    .prepare(`UPDATE catalogue_state
        SET current_revision_id = ?, published_at = ?
        WHERE singleton = 1
          AND current_revision_id = ?`)
    .bind(input.revisionId, input.publishedAt, input.expectedRevisionId);
}

export function publishApprovedRunStatement(
  database: D1Database,
  input: Readonly<{
    revisionId: string;
    manifestDigest: string;
    completedAt: string;
    progressJson: string;
    runId: string;
  }>,
): D1PreparedStatement {
  return database
    .prepare(`UPDATE ingestion_runs
        SET state = 'published',
            published_revision_id = ?,
            export_manifest_digest = ?,
            terminal_at = ?,
            progress_json = ?,
            publication_outcome = 'revision',
            resulting_revision_id = ?,
            freshness_checked_at = ?
        WHERE id = ? AND ${ingestionRunTransitionSql("publishing", "published")}`)
    .bind(
      input.revisionId,
      input.manifestDigest,
      input.completedAt,
      input.progressJson,
      input.revisionId,
      input.completedAt,
      input.runId,
    );
}

export function createPublicationBackupStatement(
  database: D1Database,
  input: Readonly<{
    idempotencyKey: string;
    requestJson: string;
    ownerToken: string;
    revisionId: string;
    objectKey: string;
    startedAt: string;
    runId: string;
  }>,
): D1PreparedStatement {
  return database
    .prepare(`INSERT INTO catalogue_backup_attempts (
         idempotency_key, request_json, owner_token, catalogue_revision_id,
         state, object_key, started_at, publication_ingestion_run_id
       ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`)
    .bind(
      input.idempotencyKey,
      input.requestJson,
      input.ownerToken,
      input.revisionId,
      input.objectKey,
      input.startedAt,
      input.runId,
    );
}

export function degradeRecoveryAfterPublicationStatement(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE operation_state SET recovery_health = 'degraded'
       WHERE singleton = 1 AND recovery_health = 'healthy'`);
}
