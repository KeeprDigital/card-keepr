// Dedicated test queries. Tests retain binding, execution, and atomic batch composition.

export function insertIngestionRuns(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO ingestion_runs (
      id, state, selected_games_json, started_at, expected_current_revision_id, idempotency_key,
      candidate_digest, candidate_created_at, approval_deadline, approval_json, candidate_json
    ) VALUES ('run_products', 'publishing', '["one-piece"]', '2026-01-01T00:00:00.000Z',
      'catrev_spine_000', 'printing-query-fixture', ?, '2026-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', ?, '{}')`);
}

export function setOperationStateActiveIngestionRunId(database: D1Database): D1PreparedStatement {
  return database.prepare("UPDATE operation_state SET active_ingestion_run_id = 'run_products' WHERE singleton = 1");
}

export function insertIngestionRunsForAuthenticatedCatalogueExportReadsPreserveRetainedD1R2Artifact(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO ingestion_runs (
        id, state, selected_games_json, started_at,
        expected_current_revision_id, linked_run_id, idempotency_key,
        candidate_digest, candidate_created_at, approval_deadline,
        approval_json, published_revision_id, export_manifest_digest,
        terminal_at, candidate_json, approval_idempotency_key
      ) VALUES (
        'run_retained_export', 'publishing', '["gundam"]', ?,
        'catrev_spine_000', NULL, 'historical-v1-seed', ?, ?,
        '2099-01-01T00:00:00.000Z', ?, NULL, NULL, NULL, '{}', NULL
      )`);
}

export function setOperationStateActiveIngestionRunIdForAuthenticatedCatalogueExportReadsPreserveRetainedD1R2Artifact(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`UPDATE operation_state
       SET active_ingestion_run_id = 'run_retained_export'
       WHERE singleton = 1`);
}

export function insertCatalogueRevisionsForAuthenticatedCatalogueExportReadsPreserveRetainedD1R2Artifact(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO catalogue_revisions (
        id, ingestion_run_id, published_at, content_digest,
        expected_previous_revision_id, approved_candidate_digest
      ) VALUES (?, 'run_retained_export', ?, ?, 'catrev_spine_000', ?)`);
}

export function insertIngestionRunsForAuthenticatedLegalityStatusGivesDefinitiveExclusionsPrecedenceWhileAuditing(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO ingestion_runs (
        id, state, selected_games_json, started_at,
        expected_current_revision_id, linked_run_id, idempotency_key,
        candidate_digest, candidate_created_at, approval_deadline,
        approval_json, published_revision_id, export_manifest_digest,
        terminal_at, candidate_json, approval_idempotency_key
      ) VALUES (
        ?, 'publishing', '["gundam"]', ?, 'catrev_spine_000', NULL,
        'api-legality-precedence-seed', ?, ?,
        '2099-01-01T00:00:00.000Z', ?, NULL, NULL, NULL, '{}', NULL
      )`);
}

export function setOperationStateActiveIngestionRunIdForAuthenticatedLegalityStatusGivesDefinitiveExclusionsPrecedenceWhileAuditing(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`UPDATE operation_state SET active_ingestion_run_id = ?
       WHERE singleton = 1`);
}

export function insertCatalogueRevisionsForAuthenticatedLegalityStatusGivesDefinitiveExclusionsPrecedenceWhileAuditing(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO catalogue_revisions (
        id, ingestion_run_id, published_at, content_digest,
        expected_previous_revision_id, approved_candidate_digest
      ) VALUES (?, ?, ?, ?, 'catrev_spine_000', ?)`);
}

export function insertIngestionRunsForLegalityStatusEvidenceReportsCapturedAtPublicationProjected(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO ingestion_runs (
        id, state, selected_games_json, started_at,
        expected_current_revision_id, linked_run_id, idempotency_key,
        candidate_digest, candidate_created_at, approval_deadline,
        approval_json, published_revision_id, export_manifest_digest,
        terminal_at, candidate_json, approval_idempotency_key
      ) VALUES (
        ?, 'publishing', '["gundam"]', ?, 'catrev_spine_000', NULL,
        'api-legality-projected-evidence-seed', ?, ?,
        '2099-01-01T00:00:00.000Z', ?, NULL, NULL, NULL, '{}', NULL
      )`);
}

export function insertIngestionRunsForUnresolvedTargetScopeRuleAnswersExplicitlyIndeterminateEveryOverlapping(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO ingestion_runs (
        id, state, selected_games_json, started_at,
        expected_current_revision_id, linked_run_id, idempotency_key,
        candidate_digest, candidate_created_at, approval_deadline,
        approval_json, published_revision_id, export_manifest_digest,
        terminal_at, candidate_json, approval_idempotency_key
      ) VALUES (
        ?, 'publishing', '["gundam"]', ?, 'catrev_spine_000', NULL,
        'api-legality-target-scope-seed', ?, ?,
        '2099-01-01T00:00:00.000Z', ?, NULL, NULL, NULL, '{}', NULL
      )`);
}

export function insertIngestionRunsForAuthenticatedLegalityStatusTargetsFunctionalDONCardAuditsUnresolved(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO ingestion_runs (
        id, state, selected_games_json, started_at,
        expected_current_revision_id, linked_run_id, idempotency_key,
        candidate_digest, candidate_created_at, approval_deadline,
        approval_json, published_revision_id, export_manifest_digest,
        terminal_at, candidate_json, approval_idempotency_key
      ) VALUES (?, 'publishing', '["one-piece"]', ?,
        'catrev_spine_000', NULL, 'api-don-seed', ?, ?,
        '2099-01-01T00:00:00.000Z', ?, NULL, NULL, NULL, '{}', NULL)`);
}

export function insertIngestionRunsForPublicPrintingResponseValidatesFullDistributionContextObjects(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO ingestion_runs (
        id, state, selected_games_json, started_at,
        expected_current_revision_id, linked_run_id, idempotency_key,
        candidate_digest, candidate_created_at, approval_deadline,
        approval_json, published_revision_id, export_manifest_digest,
        terminal_at, candidate_json, approval_idempotency_key
      ) VALUES (
        'run_api_context', 'publishing', '["one-piece"]',
        '2026-01-01T00:00:00.000Z', ?, NULL,
        'api-context-seed', ?, '2026-01-01T00:00:00.000Z',
        '2099-01-01T00:00:00.000Z', ?, NULL, NULL, NULL, '{}', NULL
      )`);
}

export function setOperationStateActiveIngestionRunIdForPublicPrintingResponseValidatesFullDistributionContextObjects(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`UPDATE operation_state
       SET active_ingestion_run_id = 'run_api_context'
       WHERE singleton = 1`);
}

export function insertCatalogueRevisionsForPublicPrintingResponseValidatesFullDistributionContextObjects(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO catalogue_revisions (
        id, ingestion_run_id, published_at, content_digest,
        expected_previous_revision_id, approved_candidate_digest
      ) VALUES (
        'catrev_api_context', 'run_api_context',
        '2026-01-01T00:00:00.000Z', ?,
        ?, ?
      )`);
}

export function setIngestionRunsStatePublishedRevisionId(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE ingestion_runs
       SET state = 'published',
           published_revision_id = 'catrev_api_context',
           resulting_revision_id = 'catrev_api_context',
           publication_outcome = 'revision',
           terminal_at = '2026-01-01T00:00:00.000Z'
       WHERE id = 'run_api_context'`);
}

export function setOperationStateActiveIngestionRunIdForPublicPrintingResponseValidatesFullDistributionContextObjectsWithRunApiContext(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`UPDATE operation_state
       SET active_ingestion_run_id = NULL
       WHERE active_ingestion_run_id = 'run_api_context'`);
}

export function insertIngestionRunsForAuthenticatedCardPrintingReadsExposeEffectivePrintedRulesText(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO ingestion_runs (
        id, state, selected_games_json, started_at,
        expected_current_revision_id, linked_run_id, idempotency_key,
        candidate_digest, candidate_created_at, approval_deadline,
        approval_json, published_revision_id, export_manifest_digest,
        terminal_at, candidate_json, approval_idempotency_key
      ) VALUES (
        'run_errata_read', 'publishing', '["one-piece"]',
        '2026-07-01T00:00:00.000Z', ?, NULL,
        'errata-read-seed', ?, '2026-07-01T00:00:00.000Z',
        '2099-01-01T00:00:00.000Z', ?, NULL, NULL, NULL, '{}', NULL
      )`);
}

export function setOperationStateActiveIngestionRunIdForAuthenticatedCardPrintingReadsExposeEffectivePrintedRulesText(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`UPDATE operation_state
       SET active_ingestion_run_id = 'run_errata_read'
       WHERE singleton = 1`);
}

export function insertCatalogueRevisionsForAuthenticatedCardPrintingReadsExposeEffectivePrintedRulesText(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO catalogue_revisions (
        id, ingestion_run_id, published_at, content_digest,
        expected_previous_revision_id, approved_candidate_digest
      ) VALUES (
        'catrev_errata_read', 'run_errata_read',
        '2026-07-01T00:00:00.000Z', ?,
        ?, ?
      )`);
}

export function setIngestionRunsStatePublishedRevisionIdForAuthenticatedCardPrintingReadsExposeEffectivePrintedRulesText(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`UPDATE ingestion_runs
       SET state = 'published',
           published_revision_id = 'catrev_errata_read',
           resulting_revision_id = 'catrev_errata_read',
           publication_outcome = 'revision',
           terminal_at = '2026-07-01T00:00:00.000Z'
       WHERE id = 'run_errata_read'`);
}

export function setOperationStateActiveIngestionRunIdForAuthenticatedCardPrintingReadsExposeEffectivePrintedRulesTextWithRunErrataRead(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`UPDATE operation_state
       SET active_ingestion_run_id = NULL
       WHERE active_ingestion_run_id = 'run_errata_read'`);
}

export function setOperationStateActiveIngestionRunIdForInstallApiSuite(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE operation_state SET active_ingestion_run_id = NULL
       WHERE singleton = 1`);
}

export function insertIngestionRunsForSeedApiRevision(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO ingestion_runs (
         id, state, selected_games_json, started_at,
         expected_current_revision_id, linked_run_id, idempotency_key,
         candidate_digest, candidate_created_at, approval_deadline,
         approval_json, published_revision_id, export_manifest_digest,
         terminal_at, candidate_json, approval_idempotency_key
       ) VALUES (
         ?, 'publishing', '["one-piece"]',
         '2026-07-20T00:00:00.000Z', ?, NULL, ?, ?,
         '2026-07-20T00:00:00.000Z',
         '2099-01-01T00:00:00.000Z', ?, NULL, NULL, NULL, '{}', NULL
       )`);
}

export function insertCatalogueRevisionsForSeedApiRevision(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO catalogue_revisions (
       id, ingestion_run_id, published_at, content_digest,
       expected_previous_revision_id, approved_candidate_digest
     ) VALUES (?, ?, '2026-07-20T00:00:00.000Z', ?, ?, ?)`);
}

export function setIngestionRunsStatePublishedRevisionIdForSeedApiRevision(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE ingestion_runs
       SET state = 'published',
           published_revision_id = ?,
           resulting_revision_id = ?,
           publication_outcome = 'revision',
           terminal_at = '2026-07-20T00:00:00.000Z'
       WHERE id = ?`);
}

export function setOperationStateActiveIngestionRunIdForSeedApiRevision(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE operation_state
       SET active_ingestion_run_id = NULL
       WHERE active_ingestion_run_id = ?`);
}

export function insertIngestionRunsForProductRelease(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO ingestion_runs (
         id, state, selected_games_json, started_at,
         expected_current_revision_id, linked_run_id, idempotency_key,
         candidate_digest, candidate_created_at, approval_deadline,
         approval_json, published_revision_id, export_manifest_digest,
         terminal_at, candidate_json, approval_idempotency_key
       ) VALUES (
         'run_products', 'publishing', '["one-piece"]',
         '2026-01-01T00:00:00.000Z', 'catrev_spine_000', NULL,
         'products-seed', ?, '2026-01-01T00:00:00.000Z',
         '2099-01-01T00:00:00.000Z', ?, NULL, NULL, NULL, '{}', NULL
       )`);
}

export function insertCatalogueRevisionsForProductRelease(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO catalogue_revisions (
         id, ingestion_run_id, published_at, content_digest,
         expected_previous_revision_id, approved_candidate_digest
       ) VALUES (
         'catrev_products', 'run_products',
         '2026-01-01T00:00:00.000Z', ?,
         'catrev_spine_000', ?
       )`);
}

export function insertIngestionRunsForPrintingDetailConditionalReadsBindExactResponseBytesOne(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO ingestion_runs (
         id, state, selected_games_json, started_at,
         expected_current_revision_id, linked_run_id, idempotency_key,
         candidate_digest, candidate_created_at, approval_deadline,
         approval_json, published_revision_id, export_manifest_digest,
         terminal_at, candidate_json, approval_idempotency_key
       ) VALUES (
         'run_products_next', 'publishing', '["one-piece"]',
         '2026-01-02T00:00:00.000Z', 'catrev_products', NULL,
         'products-next-seed', ?, '2026-01-02T00:00:00.000Z',
         '2099-01-01T00:00:00.000Z', ?, NULL, NULL, NULL, '{}', NULL
       )`);
}

export function setOperationStateActiveIngestionRunIdForPrintingDetailConditionalReadsBindExactResponseBytesOne(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`UPDATE operation_state
       SET active_ingestion_run_id = 'run_products_next'
       WHERE singleton = 1`);
}

export function insertCatalogueRevisionsForPrintingDetailConditionalReadsBindExactResponseBytesOne(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO catalogue_revisions (
         id, ingestion_run_id, published_at, content_digest,
         expected_previous_revision_id, approved_candidate_digest
       ) VALUES (
         'catrev_products_next', 'run_products_next',
         '2026-01-02T00:00:00.000Z', ?,
         'catrev_products', ?
       )`);
}

export function readOperationStateActiveIngestionRunId(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT active_ingestion_run_id FROM operation_state WHERE singleton = 1`);
}

export function countIngestionRunsCount(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT COUNT(*) AS count FROM ingestion_runs
       WHERE idempotency_key = ?`);
}

export function insertIngestionRunsForAuthenticatedReparseRejectsNormalizedFixtureEnvelopeThroughUnavailableProduction(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO ingestion_runs (
         id, state, selected_games_json, started_at,
         expected_current_revision_id, linked_run_id, idempotency_key,
         candidate_json
       ) VALUES (?, 'parsing', '["one-piece"]',
         '2026-08-01T00:00:00.000Z', 'catrev_spine_000', NULL, ?, '{}')`);
}

export function insertIngestionRunsForContextualLegalitySourceChanges(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO ingestion_runs (
           id, state, selected_games_json, started_at,
           expected_current_revision_id, linked_run_id, idempotency_key,
           candidate_json
         ) VALUES (?, 'parsing', ?, '2026-08-01T00:00:00.000Z',
           'catrev_spine_000', NULL, ?, '{}')`);
}

export function insertIngestionRunsForPublicRunBoundaryReadsRetriesImmutableFixedPointLegacy(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO ingestion_runs (
      id, state, selected_games_json, started_at,
      expected_current_revision_id, linked_run_id, idempotency_key,
      candidate_digest, candidate_created_at, approval_deadline,
      approval_json, published_revision_id, export_manifest_digest,
      terminal_at, candidate_json, approval_idempotency_key,
      failure_code, progress_json
    ) VALUES (
      ?, 'failed', '["one-piece"]', '2026-07-29T01:00:00.000Z',
      'catrev_spine_000', NULL, 'historical-fixed-point-seed',
      ?, '2026-07-29T01:00:00.000Z',
      '2026-08-05T01:00:00.000Z', NULL, NULL, NULL,
      '2026-07-29T01:02:00.000Z', ?, NULL,
      'legacy_ingestion_failure',
      '{"completed_stages":["planning","collecting","parsing","reconciling"],"current_stage":"failed"}'
    )`);
}

export function readIngestionRunsIdCandidateJson(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT id, candidate_json FROM ingestion_runs
     WHERE id IN (?, ?)
     ORDER BY id`);
}

export function setOperationStateActiveIngestionRunIdForStaleMismatchedApprovalsLeaveCandidateUnchangedBeforeExactApproval(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`UPDATE operation_state
    SET active_ingestion_run_id = 'run_mismatched'
    WHERE singleton = 1`);
}

export function insertAdministrationIdempotencyClaims(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO administration_idempotency_claims (
      idempotency_key,
      operation,
      request_json,
      claimed_at,
      owner_token,
      claim_version,
      claim_expires_at
    ) VALUES (?, 'start_ingestion_run', ?, ?, ?, 7, ?)`);
}

export function readAdministrationIdempotencyClaimsIdempotencyKey(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT idempotency_key
    FROM administration_idempotency_claims
    WHERE idempotency_key = ?`);
}

export function setIngestionRunsProgressJson(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE ingestion_runs
    SET progress_json = '{"completed_stages":["planning","parsing"],"current_stage":"awaiting_approval"}'
    WHERE id = ?`);
}

export function setIngestionRunsProgressJsonApprovalHistoryJson(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE ingestion_runs
    SET progress_json = ?,
        approval_history_json = '[{"action":"approved"}]'
    WHERE id = ?`);
}

export function setIngestionRunsApprovalHistoryJson(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE ingestion_runs
    SET approval_history_json = '[]'
    WHERE id = ?`);
}

export function insertAdministrationIdempotency(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO administration_idempotency (
      idempotency_key,
      operation,
      request_json,
      response_json,
      http_status,
      outcome,
      created_at
    ) VALUES (?, 'start_ingestion_run', ?, ?, 201, 'success', ?)`);
}

export function insertAdministrationIdempotencyForSuccessfulReplayStatusRequestCorrelationStateLegalityAreExact(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO administration_idempotency (
        idempotency_key,
        operation,
        request_json,
        response_json,
        http_status,
        outcome,
        created_at
      ) VALUES (?, 'start_ingestion_run', ?, ?, ?, 'success', ?)`);
}

export function setOperationStateActiveIngestionRunIdForExpiryRepairsDanglingActiveIdentityStillWinsAtDeadline(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`UPDATE operation_state
    SET active_ingestion_run_id = 'run_dangling_pointer'
    WHERE singleton = 1`);
}

export function setIngestionRunsStateApprovalJson(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE ingestion_runs
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
    WHERE id = ? AND state = 'awaiting_approval'`);
}

export function setIngestionRunsApprovalJson(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE ingestion_runs
      SET approval_json = '{}'
      WHERE id = ?`);
}

export function setIngestionPublicationCleanupStateAttempts(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE ingestion_publication_cleanup
    SET state = 'failed',
        attempts = 1,
        failure_code = 'synthetic_delete_failure',
        last_attempt_at = ?
    WHERE ingestion_run_id = ?`);
}

export function readAdministrationIdempotencyClaimsOwnerTokenClaimVersion(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT owner_token, claim_version
            FROM administration_idempotency_claims
            WHERE idempotency_key = ?`);
}

export function setIngestionPublicationCleanupStateAttemptsForCleanupCASLoserReplaysImmutableCompletionThatWonRace(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`UPDATE ingestion_publication_cleanup
            SET state = 'completed',
                attempts = 1,
                failure_code = NULL,
                last_attempt_at = ?,
                completed_at = ?,
                idempotency_key = ?,
                request_json = ?,
                claim_token = NULL,
                claim_version = 2,
                claim_expires_at = NULL
            WHERE ingestion_run_id = ?`);
}

export function insertAdministrationIdempotencyForCleanupCASLoserReplaysImmutableCompletionThatWonRace(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO administration_idempotency (
              idempotency_key,
              operation,
              request_json,
              response_json,
              http_status,
              outcome,
              created_at,
              claim_owner_token,
              claim_version
            ) VALUES (
              ?, 'retry_publication_cleanup', ?, ?, 200, 'success',
              ?, ?, ?
            )`);
}

export function deleteAdministrationIdempotencyClaims(database: D1Database): D1PreparedStatement {
  return database.prepare(`DELETE FROM administration_idempotency_claims
            WHERE idempotency_key = ?`);
}

export function readIngestionRunsCandidateCatalogueDigest(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT candidate_catalogue_digest
           FROM ingestion_runs WHERE id = ?`);
}

export function insertCatalogueRevisionsForNormalApprovalNeverAdoptsPrefixThatBecomesRegisteredExport(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO catalogue_revisions (
              id, ingestion_run_id, published_at, content_digest,
              expected_previous_revision_id, approved_candidate_digest
            ) VALUES (?, ?, ?, ?, ?, ?)`);
}

export function countIngestionPublicationCleanupState(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT
       run.state,
       (SELECT COUNT(*) FROM ingestion_publication_cleanup
        WHERE ingestion_run_id = run.id) AS cleanup_count,
       (SELECT current_revision_id FROM catalogue_state
        WHERE singleton = 1) AS current_revision_id
     FROM ingestion_runs AS run WHERE run.id = ?`);
}

export function readIngestionPublicationCleanupNotBefore(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT not_before FROM ingestion_publication_cleanup
     WHERE ingestion_run_id = ?`);
}

export function insertIngestionRunsForSeedDeletionExport(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO ingestion_runs (
         id, state, selected_games_json, started_at,
         expected_current_revision_id, linked_run_id, idempotency_key,
         candidate_digest, candidate_created_at, approval_deadline,
         approval_json, published_revision_id, export_manifest_digest,
         terminal_at, candidate_json, approval_idempotency_key
       ) VALUES (
         ?, 'publishing', '["one-piece"]', ?, ?, NULL, ?, ?, ?,
         '2099-01-01T00:00:00.000Z', ?, NULL, NULL, NULL, ?, NULL
       )`);
}

export function setIngestionRunsStatePublishedRevisionIdForSeedDeletionExport(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`UPDATE ingestion_runs SET state = 'published', published_revision_id = ?,
         resulting_revision_id = ?, publication_outcome = 'revision', terminal_at = ?
       WHERE id = ?`);
}

export function readIngestionRunsState(database: D1Database): D1PreparedStatement {
  return database.prepare("SELECT state FROM ingestion_runs WHERE id = ?");
}

export function readIngestionRunsCandidateJson(database: D1Database): D1PreparedStatement {
  return database.prepare("SELECT candidate_json FROM ingestion_runs WHERE id = ?");
}

export function insertAdministrationIdempotencyClaimsForAdministrationOperationLinksAreAbsolutePublicURLs(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO administration_idempotency_claims (
       idempotency_key, operation, request_json, claimed_at,
       owner_token, claim_version, claim_expires_at
     ) VALUES (?, 'retry_ingestion_run', ?, ?, ?, 1, ?)`);
}

export function countIngestionRunsCountForProductionWorkerHasNoRouteCapableInjectingSyntheticFixture(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`SELECT COUNT(*) AS count
     FROM ingestion_runs
     WHERE idempotency_key = 'production-fixture-publication-bypass'`);
}

export function insertIngestionRunsForProductionReleaseSearchFixturesComeFromRealisticRevisionPinned(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO ingestion_runs (id,state,selected_games_json,started_at,
       expected_current_revision_id,idempotency_key,candidate_digest,
       approval_deadline,candidate_json)
       VALUES ('run_release_fixture','awaiting_approval','[]',
       '2026-08-05T00:00:00.000Z','catrev_spine_000','run-release-fixture',?,
       '2099-01-01T00:00:00.000Z','{}')`);
}

export function setOperationStateActiveIngestionRunIdForProductionReleaseSearchFixturesComeFromRealisticRevisionPinned(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare("UPDATE operation_state SET active_ingestion_run_id='run_release_fixture' WHERE singleton=1");
}

export function insertCatalogueRevisionsForProductionReleaseSearchFixturesComeFromRealisticRevisionPinned(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO catalogue_revisions (id,ingestion_run_id,published_at,
     content_digest,expected_previous_revision_id,approved_candidate_digest)
     VALUES (?,'run_release_fixture','2026-08-05T00:00:00.000Z',?,
     'catrev_spine_000',?)`);
}

export function setOperationStateRecoveryHealth(database: D1Database): D1PreparedStatement {
  return database.prepare("UPDATE operation_state SET recovery_health = 'blocked' WHERE singleton = 1");
}

export function countIngestionRuns(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT
       (SELECT COUNT(*) FROM ingestion_runs
        WHERE idempotency_key = 'blocked-recovery-start') AS runs,
       active_ingestion_run_id
     FROM operation_state
     WHERE singleton = 1`);
}

export function setOperationStateRecoveryHealthForRecoveryHealthGatesFixtureEvidenceInjectionReconciliationBeforeMutation(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare("UPDATE operation_state SET recovery_health = 'healthy' WHERE singleton = 1");
}

export function setOperationStateRecoveryHealthForDegradedRecoveryPermitsEvidenceCollectionStartsRetriesWhileBlocked(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare("UPDATE operation_state SET recovery_health = 'degraded' WHERE singleton = 1");
}

export function setIngestionRunsStateTerminalAt(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE ingestion_runs
       SET state = 'failed', terminal_at = started_at,
           failure_code = 'synthetic_retry_source',
           progress_json = json_set(progress_json, '$.current_stage', 'failed')
       WHERE id = ?`);
}

export function setOperationStateActiveIngestionRunIdRecoveryHealth(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE operation_state
       SET active_ingestion_run_id = NULL, recovery_health = 'degraded'
       WHERE singleton = 1`);
}

export function countOfficialSourceCollectionPlansCount(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT COUNT(*) AS count FROM official_source_collection_plans
     WHERE ingestion_run_id = ?`);
}

export function insertIngestionRunsForD1FreshnessScopeRemainsStructuralWhileRegisteredSourceMetadata(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO ingestion_runs (
       id, state, selected_games_json, started_at,
       expected_current_revision_id, linked_run_id, idempotency_key,
       candidate_json
     ) VALUES (
       'run_future_legality_scope', 'planning', '["gundam"]',
       '2026-08-02T00:00:00.000Z', 'catrev_spine_000', NULL,
       'future-legality-scope', '{}'
     )`);
}

export function insertIngestionRunsForAppliedD1RequestCopiesOwningRunIdentitiesAreImmutable(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO ingestion_runs (
         id, state, selected_games_json, started_at,
         expected_current_revision_id, linked_run_id, idempotency_key,
         candidate_json
       ) VALUES (?, 'collecting', '["one-piece"]',
         '2026-08-01T00:00:00.000Z', 'catrev_spine_000', NULL, ?, '{}')`);
}

export function insertIngestionRunsForFreshD1EnforcesFullLowercaseDigestsCanonicalRevisionRule(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO ingestion_runs (
         id, state, selected_games_json, started_at,
         expected_current_revision_id, linked_run_id, idempotency_key,
         candidate_digest, candidate_created_at, approval_deadline,
         approval_json, candidate_json
       ) VALUES ('run_upgraded_legality_guard', 'publishing',
         '["one-piece"]', '2026-08-01T00:00:00.000Z',
         'catrev_spine_000', NULL, 'upgraded-legality-guard', ?,
         '2026-08-01T00:00:02.000Z', '2099-01-01T00:00:00.000Z', ?, '{}')`);
}

export function setOperationStateActiveIngestionRunIdForFreshD1EnforcesFullLowercaseDigestsCanonicalRevisionRule(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`UPDATE operation_state
       SET active_ingestion_run_id = 'run_upgraded_legality_guard'
       WHERE singleton = 1`);
}

export function insertCatalogueRevisionsForFreshD1EnforcesFullLowercaseDigestsCanonicalRevisionRule(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO catalogue_revisions (
         id, ingestion_run_id, published_at, content_digest,
         expected_previous_revision_id, approved_candidate_digest
       ) VALUES ('catrev_upgraded_legality_guard',
         'run_upgraded_legality_guard', '2026-08-01T00:00:03.000Z', ?,
         'catrev_spine_000', ?)`);
}

export function insertIngestionRunsForAuthenticatedParsingRetainsStagedLiveFusionPolicyRootDetail(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO ingestion_runs (
         id, state, selected_games_json, started_at,
         expected_current_revision_id, linked_run_id, idempotency_key,
         candidate_json
       ) VALUES (?, 'parsing', '["fusion-world"]',
         '2026-08-03T00:00:00.000Z', 'catrev_spine_000', NULL, ?, '{}')`);
}

export function countIngestionRunsCountForUnregisteredGenericCardAdapterCannotSelfAssertOfficialErrata(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`SELECT COUNT(*) AS count FROM ingestion_runs
       WHERE idempotency_key = 'reject-generic-production-errata-authority'`);
}

export function insertIngestionRunsForLegacyPersistedCandidatesWithoutErrataRemainInspectableRetryable(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO ingestion_runs (
         id, state, selected_games_json, started_at,
         expected_current_revision_id, linked_run_id, idempotency_key,
         candidate_digest, candidate_created_at, approval_deadline,
         approval_json, published_revision_id, export_manifest_digest,
         terminal_at, candidate_json, approval_idempotency_key,
         failure_code, progress_json, warnings_json,
         approval_history_json, publication_outcome,
         resulting_revision_id, freshness_checked_at,
         publication_revision_id, publication_started_at,
         publication_reconcile_after, publication_manifest_digest,
         publication_writer_token, candidate_catalogue_digest
       )
       SELECT ?, state, selected_games_json, started_at,
              expected_current_revision_id, NULL, ?,
              candidate_digest, candidate_created_at, approval_deadline,
              approval_json, published_revision_id, export_manifest_digest,
              terminal_at, ?, NULL,
              failure_code, progress_json, warnings_json,
              approval_history_json, publication_outcome,
              resulting_revision_id, freshness_checked_at,
              publication_revision_id, publication_started_at,
              publication_reconcile_after, publication_manifest_digest,
              publication_writer_token, candidate_catalogue_digest
       FROM ingestion_runs WHERE id = ?`);
}

export function readIngestionRunsStateTerminalAt(database: D1Database): D1PreparedStatement {
  return database.prepare("SELECT state, terminal_at, failure_code FROM ingestion_runs WHERE id = ?");
}

export function readIngestionRunsStateFailureCode(database: D1Database): D1PreparedStatement {
  return database.prepare("SELECT state, failure_code FROM ingestion_runs WHERE id = ?");
}

export function countIngestionPublicationCleanup(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT
       (SELECT COUNT(*) FROM ingestion_publication_cleanup
        WHERE ingestion_run_id = ?) AS cleanups,
       (SELECT COUNT(*) FROM administration_idempotency_claims
        WHERE idempotency_key = ?) AS claims,
       (SELECT active_ingestion_run_id FROM operation_state
        WHERE singleton = 1) AS active_ingestion_run_id,
       (SELECT current_revision_id FROM catalogue_state
        WHERE singleton = 1) AS current_revision_id`);
}

export function readIngestionRunsWarningsJson(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT warnings_json FROM ingestion_runs WHERE id = ?`);
}

export function countAdministrationIdempotencyClaims(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT
       (SELECT COUNT(*) FROM administration_idempotency_claims
        WHERE idempotency_key = ?) AS claims,
       (SELECT COUNT(*) FROM administration_idempotency
        WHERE idempotency_key = ?
          AND operation = 'approve_ingestion_run'
          AND outcome = 'problem') AS outcomes,
       (SELECT active_ingestion_run_id FROM operation_state
        WHERE singleton = 1) AS active_ingestion_run_id`);
}

export function countAdministrationIdempotencyClaimsForReservedOversizedLegalityRelationshipRecoveryPreservesTypedTerminalProblem(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`SELECT
       (SELECT COUNT(*) FROM administration_idempotency_claims
        WHERE idempotency_key = ?) AS claims,
       (SELECT COUNT(*) FROM administration_idempotency
        WHERE idempotency_key = ?
          AND operation = 'approve_ingestion_run'
          AND outcome = 'problem' AND http_status = 422) AS outcomes,
       (SELECT active_ingestion_run_id FROM operation_state
        WHERE singleton = 1) AS active_ingestion_run_id,
       (SELECT state FROM ingestion_publication_cleanup
        WHERE ingestion_run_id = ?) AS cleanup_state,
       (SELECT object_keys_json FROM ingestion_publication_cleanup
        WHERE ingestion_run_id = ?) AS cleanup_keys`);
}

export function setOperationStateActiveIngestionRunIdActiveProductionReleaseId(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(
    "UPDATE operation_state SET active_ingestion_run_id = NULL, active_production_release_id = NULL, active_production_release_expires_at = NULL, recovery_health = 'healthy' WHERE singleton = 1",
  );
}

export function insertIngestionRunsForCuratedRevisions(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO ingestion_runs (
        id, state, selected_games_json, started_at,
        expected_current_revision_id, idempotency_key, candidate_digest,
        candidate_catalogue_digest, candidate_created_at, approval_deadline,
        candidate_json, approval_json, progress_json, warnings_json, approval_history_json
      ) VALUES (
        ?, 'publishing', '["one-piece"]', ?,
        ?, ?, 'seed-digest', 'seed-digest', ?,
        '2099-01-01T00:00:00.000Z', ?,
        ?,
        '{"completed_stages":[],"current_stage":"publishing"}', '[]', '[]'
      )`);
}

export function insertCatalogueRevisionsForCuratedRevisions(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO catalogue_revisions (
        id, ingestion_run_id, published_at, content_digest,
        expected_previous_revision_id, approved_candidate_digest
      ) VALUES (?, ?, ?, 'seed-digest', ?, 'seed-digest')`);
}

export function setIngestionRunsStateTerminalAtForCuratedRevisions(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE ingestion_runs
       SET state = 'failed',
           terminal_at = COALESCE(candidate_created_at, started_at),
           failure_code = CASE WHEN state = 'publishing'
             THEN 'publication_abandoned'
             ELSE 'test_cleanup_active_run'
           END,
           progress_json = json_set(progress_json, '$.current_stage', 'failed')
       WHERE id = (
         SELECT active_ingestion_run_id FROM operation_state
         WHERE singleton = 1
       ) AND state IN (
         'planning', 'collecting', 'parsing', 'reconciling',
         'awaiting_approval', 'publishing'
       )`);
}

export function setOperationStateRecoveryHealthActiveProductionReleaseId(database: D1Database): D1PreparedStatement {
  return database.prepare(
    "UPDATE operation_state SET recovery_health = 'healthy', active_production_release_id = 'release_active', active_production_release_expires_at = '2099-01-01T00:00:00.000Z' WHERE singleton = 1",
  );
}

export function insertIngestionRunsForReleaseLeasesReclaimStaleOwnersFenceCleanupRenewal(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO ingestion_runs (
       id, state, selected_games_json, started_at,
       expected_current_revision_id, idempotency_key, candidate_json
     ) VALUES (
       ?, 'planning', '[]', ?, ?, ?,
       '{"production_release_bootstrap":true}'
     )`);
}

export function setOperationStateActiveIngestionRunIdForReleaseLeasesReclaimStaleOwnersFenceCleanupRenewal(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`UPDATE operation_state SET active_ingestion_run_id = ?
     WHERE singleton = 1 AND active_ingestion_run_id IS NULL
       AND recovery_health = 'healthy'`);
}

export function setIngestionRunsStateTerminalAtForReleaseLeasesReclaimStaleOwnersFenceCleanupRenewal(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`UPDATE ingestion_runs
       SET state = 'failed', terminal_at = ?, failure_code = ?,
           progress_json =
             '{"completed_stages":[],"current_stage":"failed"}'
       WHERE id = ? AND state = 'planning'
         AND EXISTS (
           SELECT 1 FROM operation_state
           WHERE singleton = 1 AND active_ingestion_run_id = ?
         )`);
}

export function setOperationStateActiveIngestionRunIdForReleaseLeasesReclaimStaleOwnersFenceCleanupRenewalWithundefined(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`UPDATE operation_state SET active_ingestion_run_id = NULL
     WHERE singleton = 1 AND active_ingestion_run_id = ?`);
}

export function deleteIngestionRuns(database: D1Database): D1PreparedStatement {
  return database.prepare(`DELETE FROM ingestion_runs
         WHERE id = ? AND idempotency_key = id
           AND selected_games_json = '[]'
           AND candidate_json = '{"production_release_bootstrap":true}'
           AND state IN ('planning', 'failed')
           AND NOT EXISTS (
             SELECT 1 FROM operation_state
             WHERE singleton = 1
               AND active_ingestion_run_id = ingestion_runs.id
           )`);
}

export function setOperationStateActiveIngestionRunIdForReleaseLeasesReclaimStaleOwnersFenceCleanupRenewalWithPublishing(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`UPDATE operation_state SET active_ingestion_run_id = NULL
     WHERE singleton = 1 AND active_ingestion_run_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM ingestion_runs
         WHERE id = operation_state.active_ingestion_run_id
           AND state IN (
             'planning', 'collecting', 'parsing', 'reconciling',
             'awaiting_approval', 'publishing'
           )
       )`);
}

export function readIngestionRunsId(database: D1Database): D1PreparedStatement {
  return database.prepare("SELECT id FROM ingestion_runs WHERE id = ?");
}

export function setOperationStateActiveProductionReleaseIdActiveProductionReleaseExpiresAt(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`UPDATE operation_state
     SET active_production_release_id = ?, active_production_release_expires_at = ?,
         active_ingestion_run_id = NULL
     WHERE singleton = 1 AND active_ingestion_run_id = ?
       AND (active_production_release_id IS NULL OR active_production_release_expires_at <= ?)`);
}

export function countIngestionRunsBootstrapCount(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT count(*) AS bootstrap_count FROM ingestion_runs
     WHERE id IN (?, ?)`);
}

export function setOperationStateActiveProductionReleaseIdActiveProductionReleaseExpiresAtForReleaseLeasesReclaimStaleOwnersFenceCleanupRenewal(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`UPDATE operation_state
     SET active_production_release_id = NULL, active_production_release_expires_at = NULL
     WHERE singleton = 1 AND active_production_release_id = ?`);
}

export function setOperationStateActiveProductionReleaseExpiresAt(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE operation_state SET active_production_release_expires_at = ?
     WHERE singleton = 1 AND active_production_release_id = ?
       AND active_production_release_expires_at > ?`);
}

export function readOperationStateActiveProductionReleaseIdActiveProductionReleaseExpiresAt(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`SELECT active_production_release_id, active_production_release_expires_at
     FROM operation_state WHERE singleton = 1`);
}

export function setOperationStateActiveProductionReleaseExpiresAtForReleaseLeasesReclaimStaleOwnersFenceCleanupRenewal(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(
    "UPDATE operation_state SET active_production_release_expires_at = ? WHERE singleton = 1 AND active_production_release_id = ?",
  );
}

export function setOperationStateActiveProductionReleaseIdActiveProductionReleaseExpiresAtForReleaseLeasesReclaimStaleOwnersFenceCleanupRenewalWithundefined(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`UPDATE operation_state
     SET active_production_release_id = ?, active_production_release_expires_at = ?,
         active_ingestion_run_id = NULL
     WHERE singleton = 1 AND active_ingestion_run_id = ?
       AND active_production_release_expires_at <= ?`);
}

export function readOperationStateActiveProductionReleaseId(database: D1Database): D1PreparedStatement {
  return database.prepare("SELECT active_production_release_id FROM operation_state WHERE singleton = 1");
}

export function readIngestionRunsCandidateJsonForCandidateInspectionExposesExactPinnedSetEveryCuratedEffect(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare("SELECT candidate_json FROM ingestion_runs WHERE idempotency_key = ?");
}

export function setIngestionRunsStateProgressJson(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE ingestion_runs SET state = 'reconciling',
       progress_json =
         '{"completed_stages":["planning","collecting","parsing"],"current_stage":"reconciling"}'
     WHERE id = ?`);
}

export function setIngestionRunsStateCandidateJson(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE ingestion_runs
     SET state = 'awaiting_approval', candidate_json = ?,
         candidate_digest = ?, candidate_catalogue_digest = ?,
         candidate_created_at = ?, approval_deadline = ?,
         progress_json =
           '{"completed_stages":["planning","collecting","parsing","reconciling"],"current_stage":"awaiting_approval"}'
     WHERE id = ?`);
}

export function insertIngestionRunsForPreparedRunsStripPriorEffectsReapplyExactPinsPersist(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO ingestion_runs (
         id, state, selected_games_json, started_at,
         expected_current_revision_id, idempotency_key, candidate_json,
         progress_json, warnings_json, approval_history_json
       ) VALUES (?, 'planning', '["one-piece"]', ?, ?, ?, '{}',
         '{"completed_stages":[],"current_stage":"planning"}', '[]', '[]')`);
}

export function readIngestionRunCuratedRevisionSetsRevisionIdsJsonSetDigest(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT revision_ids_json, set_digest
     FROM ingestion_run_curated_revision_sets WHERE ingestion_run_id = ?`);
}

export function insertIngestionRunsForPreparedRetryPersistsFailedRunEverySourceChangeConflict(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO ingestion_runs (
       id, state, selected_games_json, started_at,
       expected_current_revision_id, idempotency_key, candidate_digest,
       candidate_catalogue_digest, candidate_created_at, terminal_at,
       candidate_json, failure_code, progress_json, warnings_json,
       approval_history_json
     ) VALUES (?, 'failed', '["one-piece"]', ?, ?, ?, ?, ?, ?, ?, ?,
       'prior_failure',
       '{"completed_stages":["planning","collecting","parsing","reconciling"],"current_stage":"failed"}',
       '[]', '[]')`);
}

export function setIngestionRunsCandidateJson(database: D1Database): D1PreparedStatement {
  return database.prepare("UPDATE ingestion_runs SET candidate_json = '{}' WHERE id = ?");
}

export function insertIngestionRunsForWorkerBindsSourceChangeReaffirmationExactPublicConflict(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO ingestion_runs (
       id, state, selected_games_json, started_at,
       expected_current_revision_id, idempotency_key, candidate_digest,
       candidate_catalogue_digest, candidate_created_at, terminal_at,
       candidate_json, failure_code, progress_json, warnings_json,
       approval_history_json
     ) VALUES (?, 'failed', '["one-piece"]', ?, ?, ?, ?, ?, ?, ?, ?,
       'test_source_changed',
       '{"completed_stages":["planning","collecting","parsing","reconciling"],"current_stage":"failed"}',
       '[]', '[]')`);
}

export function insertIngestionRunsForWorkerBindsSourceChangeReaffirmationExactPublicConflictWithCompletedStagesPlanningCollectingParsingReconciling(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO ingestion_runs (
       id, state, selected_games_json, started_at,
       expected_current_revision_id, idempotency_key, candidate_digest,
       candidate_catalogue_digest, candidate_created_at, terminal_at,
       candidate_json, failure_code, progress_json, warnings_json,
       approval_history_json
     ) VALUES (?, 'failed', '["digimon"]', ?, ?, ?, ?, ?, ?, ?, ?,
       'test_unaffected_game',
       '{"completed_stages":["planning","collecting","parsing","reconciling"],"current_stage":"failed"}',
       '[]', '[]')`);
}

export function readIngestionRunsStateFailureCodeForChangedOfficialValueRequiresReconfirmationInsteadSilentlyApplying(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare("SELECT state, failure_code, terminal_at FROM ingestion_runs WHERE id = ?");
}

export function setIngestionRunsStateTerminalAtForFieldAbsenceDistinctFromNullRetirementRestoresExactAbsence(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(
    "UPDATE ingestion_runs SET state = 'failed', terminal_at = ?, failure_code = 'test_complete' WHERE id = ?",
  );
}

export function setOperationStateRecoveryHealthActiveProductionReleaseIdForWorkerLifecycleEndpointsFailClosedOnEveryMutationGuard(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`UPDATE operation_state
     SET recovery_health = 'healthy', active_production_release_id = 'release_guard',
         active_production_release_expires_at = '2099-01-01T00:00:00.000Z'
     WHERE singleton = 1`);
}

export function setOperationStateActiveProductionReleaseIdActiveProductionReleaseExpiresAtForWorkerLifecycleEndpointsFailClosedOnEveryMutationGuard(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`UPDATE operation_state
     SET active_production_release_id = NULL, active_production_release_expires_at = NULL
     WHERE singleton = 1`);
}

export function readIngestionRunCuratedRevisionSetsRevisionIdsJsonSetDigestForEmptyCuratedRevisionSetStillPinnedDigest(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(
    "SELECT revision_ids_json, set_digest, pinned_at FROM ingestion_run_curated_revision_sets WHERE ingestion_run_id = ?",
  );
}

export function setIngestionRunCuratedRevisionSetsSetDigest(database: D1Database): D1PreparedStatement {
  return database.prepare("UPDATE ingestion_run_curated_revision_sets SET set_digest = ? WHERE ingestion_run_id = ?");
}

export function insertIngestionRunsForInsertParsingRun(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO ingestion_runs (
        id, state, selected_games_json, started_at,
        expected_current_revision_id, idempotency_key, candidate_json,
        progress_json, warnings_json, approval_history_json
      ) VALUES (?, 'parsing', ?, ?, ?, ?, '{}',
        '{"completed_stages":["planning","collecting"],"current_stage":"parsing"}', '[]', '[]')`);
}

export function insertIngestionRunsForPublishedEvidenceDiagnosticsExplicitlyAdvertiseNoRetryRoute(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`INSERT INTO ingestion_runs (
         id, state, selected_games_json, started_at,
         expected_current_revision_id, linked_run_id, idempotency_key,
         operational_request_id, terminal_at, candidate_json
       ) VALUES (
         ?, 'published', '["one-piece"]', ?, 'catrev_spine_000', NULL, ?,
         ?, ?, '{}'
       )`);
}

export function readIngestionRunsStateCandidateDigest(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT state, candidate_digest, expected_current_revision_id,
              approval_json, approval_idempotency_key,
              published_revision_id, publication_outcome,
              resulting_revision_id
       FROM ingestion_runs WHERE id = ?`);
}

export function readIngestionRunsCandidateCatalogueDigestContentDigest(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT run.candidate_catalogue_digest, revision.content_digest
     FROM ingestion_runs AS run
     JOIN catalogue_revisions AS revision ON revision.id = ?
     WHERE run.id = ?`);
}

export function readIngestionRunsCandidateDigestCandidateCatalogueDigest(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT run.candidate_digest, run.candidate_catalogue_digest,
            revision.content_digest
     FROM ingestion_runs AS run
     JOIN catalogue_revisions AS revision ON revision.id = ?
     WHERE run.id = ?`);
}

export function readIngestionRunsStateTerminalAtForReachingRequestCapacityPausesIngestionRunWithoutFailingRetained(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`SELECT state, terminal_at, failure_code, progress_json
     FROM ingestion_runs WHERE id = ?`);
}

export function setOperationStateActiveRecoveryIdActiveIngestionRunId(database: D1Database): D1PreparedStatement {
  return database.prepare(
    "UPDATE operation_state SET active_recovery_id = NULL, active_ingestion_run_id = NULL, active_production_release_id = NULL, active_production_release_expires_at = NULL WHERE singleton = 1 AND recovery_health = 'healthy'",
  );
}

export function readOperationStateRecoveryHealth(database: D1Database): D1PreparedStatement {
  return database.prepare("SELECT recovery_health FROM operation_state WHERE singleton = 1");
}

export function readOperationStateRecoveryHealthActiveRecoveryId(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT recovery_health, active_recovery_id, recovery_restore_guard
     FROM operation_state WHERE singleton = 1`);
}

export function setOperationStateRecoveryHealthActiveRecoveryId(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE operation_state
         SET recovery_health = 'healthy', active_recovery_id = NULL,
             recovery_restore_guard = 'blocked'
         WHERE singleton = 1`);
}

export function setOperationStateRecoveryRestoreGuard(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE operation_state SET recovery_restore_guard = 'blocked'
     WHERE singleton = 1`);
}

export function setOperationStateRecoveryHealthActiveIngestionRunId(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE operation_state
     SET recovery_health = 'healthy', active_ingestion_run_id = NULL
     WHERE singleton = 1`);
}
