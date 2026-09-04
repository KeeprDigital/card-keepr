// Dedicated test queries. Tests retain binding, execution, and atomic batch composition.

export function insertReconciledPrintingImages(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO reconciled_printing_images (
         id, printing_id, role, media_type, width, height,
         content_sha256, content_byte_length, object_key
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
}

export function deleteReconciledReleases(database: D1Database): D1PreparedStatement {
  return database.prepare(`DELETE FROM reconciled_releases WHERE id = ?`);
}

export function deleteReconciledProducts(database: D1Database): D1PreparedStatement {
  return database.prepare(`DELETE FROM reconciled_products WHERE id = ?`);
}

export function insertReconciledPrintingImagesForPrintingImageContentServedFromRevisionProjectionNotReconciled(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO reconciled_printing_images (
         id, printing_id, role, media_type, width, height,
         content_sha256, content_byte_length, object_key
       ) VALUES ('printing_image_st15_projected', 'printing_st15_event', 'other',
         'image/png', 1, 1, ?, 3, 'printing-images/unpublished')`);
}

export function countReconciliationPayloadChunksCountBLOB(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT COUNT(*) AS count,
            MAX(length(CAST(content AS BLOB))) AS maximum_bytes,
            SUM(
              CASE WHEN payload_kind = 'candidate'
                THEN length(CAST(content AS BLOB))
                ELSE 0
              END
            ) AS candidate_bytes
     FROM reconciliation_payload_chunks
     WHERE ingestion_run_id = ?`);
}

export function readReconciliationPayloadChunksBLOBCandidateBytes(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT SUM(length(CAST(content AS BLOB))) AS candidate_bytes
     FROM reconciliation_payload_chunks
     WHERE ingestion_run_id = ? AND payload_kind = 'candidate'`);
}

export function readReconciliationCandidatesSourceObservationId(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT source_observation_id FROM reconciliation_candidates
     WHERE ingestion_run_id = ? ORDER BY source_observation_id LIMIT 1`);
}

export function readRevisionPrintingImagesReconciledMediaTypeReconciledContentSha256(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`SELECT projection.image_id, projection.media_type, projection.content_sha256,
            projection.content_byte_length, projection.object_key,
            image.media_type AS reconciled_media_type,
            image.content_sha256 AS reconciled_content_sha256,
            image.content_byte_length AS reconciled_content_byte_length,
            image.object_key AS reconciled_object_key
     FROM revision_printing_images AS projection
     JOIN reconciled_printing_images AS image ON image.id = projection.image_id
     WHERE projection.catalogue_revision_id = ?
     ORDER BY projection.image_id`);
}

export function readReconciliationCandidatesRequestIdSourceSnapshotId(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT request.request_id, candidate.source_snapshot_id,
            candidate.source_observation_set_id
     FROM reconciliation_candidates AS candidate
     JOIN source_snapshots AS snapshot
       ON snapshot.id = candidate.source_snapshot_id
     JOIN source_requests AS request
       ON request.ingestion_run_id = snapshot.ingestion_run_id
      AND request.source_snapshot_id = snapshot.id
     WHERE candidate.ingestion_run_id = ?
     ORDER BY request.sequence_number`);
}

export function readReconciliationEvidencePartitionsSequenceNumberRequestId(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT sequence_number, request_id, source_snapshot_id,
              source_observation_set_id
       FROM reconciliation_evidence_partitions
       WHERE ingestion_run_id = ?
       ORDER BY sequence_number`);
}

export function readReconciliationPayloadChunksValue(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT group_concat(content, '') AS value
       FROM (
         SELECT content
         FROM reconciliation_payload_chunks
         WHERE ingestion_run_id = ? AND payload_kind = 'digest'
         ORDER BY chunk_index
       )`);
}

export function readReconciledWithdrawalAssertionsEvidenceJson(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT evidence_json
     FROM reconciled_withdrawal_assertions
     WHERE entity_type = 'printing' AND entity_id = ?
     ORDER BY source_observation_id`);
}

export function readReconciledCardObservationsCurrentLastMissingRevisionId(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT current, last_missing_revision_id
     FROM reconciled_card_observations
     WHERE card_id = ? AND source_lineage = 'gundam-en-us'
     ORDER BY catalogue_revision_id DESC
     LIMIT 1`);
}

export function readReconciledPrintingLocatorsCurrentLastMissingRevisionId(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT current, last_missing_revision_id
     FROM reconciled_printing_locators
     WHERE printing_id = ? AND source_lineage = 'gundam-en-us'`);
}

export function readReconciledErrataIdSourceLineage(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT erratum.id, provenance.source_lineage,
              provenance.source_observation_id
       FROM reconciled_errata AS erratum
       JOIN erratum_provenance AS provenance
         ON provenance.erratum_id = erratum.id
       JOIN revision_errata AS revision
         ON revision.erratum_id = erratum.id
       WHERE revision.catalogue_revision_id = ? AND erratum.id = ?`);
}

export function readReconciledCardObservationsCanonicalFactsJson(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT canonical_facts_json
       FROM reconciled_card_observations
       WHERE card_id = ? AND source_observation_id = ?`);
}

export function setReconciledErrataCorrectedValueJson(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE reconciled_errata
         SET corrected_value_json = '"mutated wording"'
         WHERE id = ?`);
}

export function readReconciledErrataLastObservedRevisionId(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT last_observed_revision_id
       FROM reconciled_errata
       WHERE id = ?`);
}

export function readReconciledErrataFirstRevisionIdLastObservedRevisionId(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT first_revision_id, last_observed_revision_id
           FROM reconciled_errata WHERE id = ?`);
}

export function insertReconciledErrata(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO reconciled_errata (
           id, game, target_type, target_id, effective_from,
           official_wording, corrected_value_json,
           first_revision_id, last_observed_revision_id
         ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`);
}

export function countReconciliationWorkflowRequestsCount(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT COUNT(*) AS count
       FROM reconciliation_workflow_requests
       WHERE ingestion_run_id = ?`);
}

export function readReconciliationWorkflowRequestsWorkflowParamsJson(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT workflow_params_json
     FROM reconciliation_workflow_requests
     WHERE ingestion_run_id = ?`);
}

export function readReconciliationPayloadChunks(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT
       CASE
         WHEN candidate_json =
           '{"chunked_reconciliation_payload":"candidate"}'
         THEN (
           SELECT group_concat(content, '')
           FROM (
             SELECT content
             FROM reconciliation_payload_chunks
             WHERE ingestion_run_id = ingestion_runs.id
               AND payload_kind = 'candidate'
             ORDER BY chunk_index
           )
         )
         ELSE candidate_json
       END AS candidate_json,
       candidate_catalogue_digest
     FROM ingestion_runs
     WHERE id = ?`);
}

export function insertReconciledProductRelationships(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO reconciled_product_relationships (
         id, supported_game, relationship_kind, from_type, from_id,
         to_type, to_id, evidence_category, source_lineage,
         source_observation_ids_json, relationship_value,
         first_revision_id, last_observed_revision_id, current,
         last_missing_revision_id, document_json
       ) VALUES (?, 'one-piece', 'product-card', 'product', ?,
         'card', ?, 'explicit', 'one-piece-en', ?, ?, ?, ?, 1, NULL, ?)`);
}

export function readReconciledProductsIdOfficialCode(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT id, official_code FROM reconciled_products WHERE id = ?`);
}

export function setReconciledProductsOfficialCode(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE reconciled_products
         SET official_code = 'INCOMPATIBLE-CODE'
         WHERE id = ?`);
}

export function readReconciledReleasesRegionFirstRevisionId(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT region, first_revision_id, last_observed_revision_id
     FROM reconciled_releases
     WHERE product_id = ?
     ORDER BY region`);
}

export function readReconciledDistributionContextsCurrentSourceLineagesJson(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT current, source_lineages_json
     FROM reconciled_distribution_contexts
     WHERE context_key = 'championship-2026-pack'`);
}

export function countReconciledProductRelationshipsCount(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT COUNT(*) AS count
       FROM reconciled_product_relationships
       WHERE relationship_value = ?`);
}

export function readReconciliationTerminalResultsResultJson(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT result_json FROM reconciliation_terminal_results
       WHERE ingestion_run_id = ?`);
}

export function readReconciledPrintingLocatorsLastObservedRevisionIdCurrent(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT last_observed_revision_id, current
     FROM reconciled_printing_locators
     WHERE printing_id = ? AND locator = '/official/evidence/relocated'`);
}

export function readReconciliationCandidatesSourceObservationIdForLocatorSourceBucketEvidenceRefreshWithoutMintingCatalogueRevisionsOr(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`SELECT source_observation_id
     FROM reconciliation_candidates
     WHERE ingestion_run_id = ?
       AND printing_id = ?
       AND locator = '/official/evidence/relocated'`);
}

export function readReconciledPrintingMembershipsSourceObservationIdLastObservedRevisionId(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`SELECT source_observation_id, last_observed_revision_id, current
     FROM reconciled_printing_memberships
     WHERE printing_id = ?
       AND relationship_kind = 'source_bucket'
       AND relationship_value = 'secondary-card-list'`);
}

export function readReconciledCardObservationsSourceLineageCanonicalFactsJson(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`SELECT source_lineage, canonical_facts_json, current
     FROM reconciled_card_observations
     WHERE card_id = ?
     ORDER BY catalogue_revision_id`);
}

export function readReconciledCardObservationsSourceObservationIdCatalogueRevisionId(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`SELECT source_observation_id, catalogue_revision_id, current
     FROM reconciled_card_observations
     WHERE card_id = ? AND source_lineage = 'one-piece-en' AND current = 1`);
}

export function readReconciledPrintingMembershipsSourceObservationIdLastObservedRevisionIdForSequentialSelectedGamePublicationsRetainCompleteCurrentCatalogueAcross(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`SELECT source_observation_id, last_observed_revision_id, current
     FROM reconciled_printing_memberships
     WHERE printing_id = ?
       AND source_lineage = 'one-piece-en'
       AND relationship_kind = 'product'
       AND relationship_value = 'product_op01'
       AND current = 1`);
}

export function readReconciliationPayloadChunksCandidateDigest(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT candidate.candidate_digest,
            (
              SELECT group_concat(content, '')
              FROM (
                SELECT content
                FROM reconciliation_payload_chunks
                WHERE ingestion_run_id = candidate.id
                  AND payload_kind = 'digest'
                ORDER BY chunk_index
              )
            ) AS digest_payload_json
     FROM ingestion_runs AS candidate
     WHERE candidate.id = ?
     LIMIT 1`);
}

export function readReconciledPrintingLocatorsPrintingIdCurrent(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT printing_id, current, last_missing_revision_id
     FROM reconciled_printing_locators
     WHERE source_lineage = 'one-piece-en'
       AND locator = '/official/locator-binding/stable'`);
}
