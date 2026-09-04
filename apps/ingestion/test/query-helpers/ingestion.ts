import {
  catalogueStore,
  runCompletedStageCount,
  runEventCommand,
  runEventIdentitySql,
  runEventStatement,
} from "../../../../src/catalogue/shared";
import { bindRunFixtureStatement, seedRunFixtureStatement } from "./run-events";
// Dedicated test queries. Tests retain binding, execution, and atomic batch composition.

export function insertIngestionRuns(database: D1Database): D1PreparedStatement {
  return bindRunFixtureStatement(database, (...values) => ({
    id: "run_products",
    state: "publishing",
    selected_games_json: '["one-piece"]',
    started_at: "2026-01-01T00:00:00.000Z",
    expected_current_revision_id: "catrev_spine_000",
    idempotency_key: "printing-query-fixture",
    candidate_digest: values[0],
    candidate_created_at: "2026-01-01T00:00:00.000Z",
    approval_deadline: "2099-01-01T00:00:00.000Z",
    approval_json: values[1],
    candidate_json: "{}",
  }));
}

export function setOperationStateActiveIngestionRunId(database: D1Database): D1PreparedStatement {
  return database.prepare("UPDATE operation_state SET active_ingestion_run_id = 'run_products' WHERE singleton = 1");
}

export function insertIngestionRunsForAuthenticatedCatalogueExportReadsPreserveRetainedD1R2Artifact(
  database: D1Database,
): D1PreparedStatement {
  return bindRunFixtureStatement(database, (...values) => ({
    id: "run_retained_export",
    state: "publishing",
    selected_games_json: '["gundam"]',
    started_at: values[0],
    expected_current_revision_id: "catrev_spine_000",
    linked_run_id: null,
    idempotency_key: "historical-v1-seed",
    candidate_digest: values[1],
    candidate_created_at: values[2],
    approval_deadline: "2099-01-01T00:00:00.000Z",
    approval_json: values[3],
    published_revision_id: null,
    export_manifest_digest: null,
    terminal_at: null,
    candidate_json: "{}",
    approval_idempotency_key: null,
  }));
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
  return bindRunFixtureStatement(database, (...values) => ({
    id: values[0],
    state: "publishing",
    selected_games_json: '["gundam"]',
    started_at: values[1],
    expected_current_revision_id: "catrev_spine_000",
    linked_run_id: null,
    idempotency_key: "api-legality-precedence-seed",
    candidate_digest: values[2],
    candidate_created_at: values[3],
    approval_deadline: "2099-01-01T00:00:00.000Z",
    approval_json: values[4],
    published_revision_id: null,
    export_manifest_digest: null,
    terminal_at: null,
    candidate_json: "{}",
    approval_idempotency_key: null,
  }));
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
  return bindRunFixtureStatement(database, (...values) => ({
    id: values[0],
    state: "publishing",
    selected_games_json: '["gundam"]',
    started_at: values[1],
    expected_current_revision_id: "catrev_spine_000",
    linked_run_id: null,
    idempotency_key: "api-legality-projected-evidence-seed",
    candidate_digest: values[2],
    candidate_created_at: values[3],
    approval_deadline: "2099-01-01T00:00:00.000Z",
    approval_json: values[4],
    published_revision_id: null,
    export_manifest_digest: null,
    terminal_at: null,
    candidate_json: "{}",
    approval_idempotency_key: null,
  }));
}

export function insertIngestionRunsForUnresolvedTargetScopeRuleAnswersExplicitlyIndeterminateEveryOverlapping(
  database: D1Database,
): D1PreparedStatement {
  return bindRunFixtureStatement(database, (...values) => ({
    id: values[0],
    state: "publishing",
    selected_games_json: '["gundam"]',
    started_at: values[1],
    expected_current_revision_id: "catrev_spine_000",
    linked_run_id: null,
    idempotency_key: "api-legality-target-scope-seed",
    candidate_digest: values[2],
    candidate_created_at: values[3],
    approval_deadline: "2099-01-01T00:00:00.000Z",
    approval_json: values[4],
    published_revision_id: null,
    export_manifest_digest: null,
    terminal_at: null,
    candidate_json: "{}",
    approval_idempotency_key: null,
  }));
}

export function insertIngestionRunsForAuthenticatedLegalityStatusTargetsFunctionalDONCardAuditsUnresolved(
  database: D1Database,
): D1PreparedStatement {
  return bindRunFixtureStatement(database, (...values) => ({
    id: values[0],
    state: "publishing",
    selected_games_json: '["one-piece"]',
    started_at: values[1],
    expected_current_revision_id: "catrev_spine_000",
    linked_run_id: null,
    idempotency_key: "api-don-seed",
    candidate_digest: values[2],
    candidate_created_at: values[3],
    approval_deadline: "2099-01-01T00:00:00.000Z",
    approval_json: values[4],
    published_revision_id: null,
    export_manifest_digest: null,
    terminal_at: null,
    candidate_json: "{}",
    approval_idempotency_key: null,
  }));
}

export function insertIngestionRunsForPublicPrintingResponseValidatesFullDistributionContextObjects(
  database: D1Database,
): D1PreparedStatement {
  return bindRunFixtureStatement(database, (...values) => ({
    id: "run_api_context",
    state: "publishing",
    selected_games_json: '["one-piece"]',
    started_at: "2026-01-01T00:00:00.000Z",
    expected_current_revision_id: values[0],
    linked_run_id: null,
    idempotency_key: "api-context-seed",
    candidate_digest: values[1],
    candidate_created_at: "2026-01-01T00:00:00.000Z",
    approval_deadline: "2099-01-01T00:00:00.000Z",
    approval_json: values[2],
    published_revision_id: null,
    export_manifest_digest: null,
    terminal_at: null,
    candidate_json: "{}",
    approval_idempotency_key: null,
  }));
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
  const store = catalogueStore(database);
  const event = runEventCommand("published", { runId: "run_api_context" });
  return runEventStatement(store, {
    event,
    statement: database
      .prepare(`UPDATE ingestion_run_current
       SET ${runEventIdentitySql}, state = 'published',
           published_revision_id = 'catrev_api_context',
           resulting_revision_id = 'catrev_api_context',
           publication_outcome = 'revision',
           terminal_at = '2026-01-01T00:00:00.000Z'
       WHERE ingestion_run_id = 'run_api_context'`)
      .bind(event.eventId),
  });
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
  return bindRunFixtureStatement(database, (...values) => ({
    id: "run_errata_read",
    state: "publishing",
    selected_games_json: '["one-piece"]',
    started_at: "2026-07-01T00:00:00.000Z",
    expected_current_revision_id: values[0],
    linked_run_id: null,
    idempotency_key: "errata-read-seed",
    candidate_digest: values[1],
    candidate_created_at: "2026-07-01T00:00:00.000Z",
    approval_deadline: "2099-01-01T00:00:00.000Z",
    approval_json: values[2],
    published_revision_id: null,
    export_manifest_digest: null,
    terminal_at: null,
    candidate_json: "{}",
    approval_idempotency_key: null,
  }));
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
  const store = catalogueStore(database);
  const event = runEventCommand("published", { runId: "run_errata_read" });
  return runEventStatement(store, {
    event,
    statement: database
      .prepare(`UPDATE ingestion_run_current
       SET ${runEventIdentitySql}, state = 'published',
           published_revision_id = 'catrev_errata_read',
           resulting_revision_id = 'catrev_errata_read',
           publication_outcome = 'revision',
           terminal_at = '2026-07-01T00:00:00.000Z'
       WHERE ingestion_run_id = 'run_errata_read'`)
      .bind(event.eventId),
  });
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
  return bindRunFixtureStatement(database, (...values) => ({
    id: values[0],
    state: "publishing",
    selected_games_json: '["one-piece"]',
    started_at: "2026-07-20T00:00:00.000Z",
    expected_current_revision_id: values[1],
    linked_run_id: null,
    idempotency_key: values[2],
    candidate_digest: values[3],
    candidate_created_at: "2026-07-20T00:00:00.000Z",
    approval_deadline: "2099-01-01T00:00:00.000Z",
    approval_json: values[4],
    published_revision_id: null,
    export_manifest_digest: null,
    terminal_at: null,
    candidate_json: "{}",
    approval_idempotency_key: null,
  }));
}

export function insertCatalogueRevisionsForSeedApiRevision(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO catalogue_revisions (
       id, ingestion_run_id, published_at, content_digest,
       expected_previous_revision_id, approved_candidate_digest
     ) VALUES (?, ?, '2026-07-20T00:00:00.000Z', ?, ?, ?)`);
}

export function setIngestionRunsStatePublishedRevisionIdForSeedApiRevision(database: D1Database): D1PreparedStatement {
  return bindFixtureMutation((...values) => {
    const store = catalogueStore(database);
    const event = runEventCommand("published", { runId: String(values[2]) });
    return runEventStatement(store, {
      event,
      statement: database
        .prepare(`UPDATE ingestion_run_current
       SET ${runEventIdentitySql}, state = 'published',
           published_revision_id = ?,
           resulting_revision_id = ?,
           publication_outcome = 'revision',
           terminal_at = '2026-07-20T00:00:00.000Z'
       WHERE ingestion_run_id = ?`)
        .bind(event.eventId, ...values),
    });
  });
}

export function setOperationStateActiveIngestionRunIdForSeedApiRevision(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE operation_state
       SET active_ingestion_run_id = NULL
       WHERE active_ingestion_run_id = ?`);
}

export function insertIngestionRunsForProductRelease(database: D1Database): D1PreparedStatement {
  return bindRunFixtureStatement(database, (...values) => ({
    id: "run_products",
    state: "publishing",
    selected_games_json: '["one-piece"]',
    started_at: "2026-01-01T00:00:00.000Z",
    expected_current_revision_id: "catrev_spine_000",
    linked_run_id: null,
    idempotency_key: "products-seed",
    candidate_digest: values[0],
    candidate_created_at: "2026-01-01T00:00:00.000Z",
    approval_deadline: "2099-01-01T00:00:00.000Z",
    approval_json: values[1],
    published_revision_id: null,
    export_manifest_digest: null,
    terminal_at: null,
    candidate_json: "{}",
    approval_idempotency_key: null,
  }));
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
  return bindRunFixtureStatement(database, (...values) => ({
    id: "run_products_next",
    state: "publishing",
    selected_games_json: '["one-piece"]',
    started_at: "2026-01-02T00:00:00.000Z",
    expected_current_revision_id: "catrev_products",
    linked_run_id: null,
    idempotency_key: "products-next-seed",
    candidate_digest: values[0],
    candidate_created_at: "2026-01-02T00:00:00.000Z",
    approval_deadline: "2099-01-01T00:00:00.000Z",
    approval_json: values[1],
    published_revision_id: null,
    export_manifest_digest: null,
    terminal_at: null,
    candidate_json: "{}",
    approval_idempotency_key: null,
  }));
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
  return database.prepare(`SELECT COUNT(*) AS count FROM ingestion_run_read
       WHERE idempotency_key = ?`);
}

export function insertIngestionRunsForAuthenticatedReparseRejectsNormalizedFixtureEnvelopeThroughUnavailableProduction(
  database: D1Database,
): D1PreparedStatement {
  return bindRunFixtureStatement(database, (...values) => ({
    id: values[0],
    state: "parsing",
    selected_games_json: '["one-piece"]',
    started_at: "2026-08-01T00:00:00.000Z",
    expected_current_revision_id: "catrev_spine_000",
    linked_run_id: null,
    idempotency_key: values[1],
    candidate_json: "{}",
  }));
}

export function insertIngestionRunsForContextualLegalitySourceChanges(database: D1Database): D1PreparedStatement {
  return bindRunFixtureStatement(database, (...values) => ({
    id: values[0],
    state: "parsing",
    selected_games_json: values[1],
    started_at: "2026-08-01T00:00:00.000Z",
    expected_current_revision_id: "catrev_spine_000",
    linked_run_id: null,
    idempotency_key: values[2],
    candidate_json: "{}",
  }));
}

export function insertIngestionRunsForPublicRunBoundaryReadsRetriesImmutableFixedPointLegacy(
  database: D1Database,
): D1PreparedStatement {
  return bindRunFixtureStatement(database, (...values) => ({
    id: values[0],
    state: "failed",
    selected_games_json: '["one-piece"]',
    started_at: "2026-07-29T01:00:00.000Z",
    expected_current_revision_id: "catrev_spine_000",
    linked_run_id: null,
    idempotency_key: "historical-fixed-point-seed",
    candidate_digest: values[1],
    candidate_created_at: "2026-07-29T01:00:00.000Z",
    approval_deadline: "2026-08-05T01:00:00.000Z",
    approval_json: null,
    published_revision_id: null,
    export_manifest_digest: null,
    terminal_at: "2026-07-29T01:02:00.000Z",
    candidate_json: values[2],
    approval_idempotency_key: null,
    failure_code: "legacy_ingestion_failure",
    progress_json: '{"completed_stages":["planning","collecting","parsing","reconciling"],"current_stage":"failed"}',
  }));
}

export function readIngestionRunsIdCandidateJson(database: D1Database): D1PreparedStatement {
  return database.prepare(
    `SELECT id, candidate_json FROM ingestion_run_read
     WHERE id IN (?, ?)
     ORDER BY id`,
  );
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
    ) VALUES (?, 'retry_ingestion_run', ?, ?, ?, 7, ?)`);
}

export function readAdministrationIdempotencyClaimsIdempotencyKey(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT idempotency_key
    FROM administration_idempotency_claims
    WHERE idempotency_key = ?`);
}

export function setIngestionRunsProgressJson(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE ingestion_run_current SET completed_stage_count = 2 WHERE ingestion_run_id = ?`);
}

export function setIngestionRunsProgressJsonApprovalHistoryJson(database: D1Database): D1PreparedStatement {
  return database.prepare(
    `UPDATE ingestion_run_current SET completed_stage_count = json_array_length(json_extract(?, '$.completed_stages')), approved_at = 'invalid', approved_candidate_digest = NULL, approved_expected_revision_id = NULL WHERE ingestion_run_id = ?`,
  );
}

export function setIngestionRunsApprovalHistoryJson(database: D1Database): D1PreparedStatement {
  return database.prepare(
    `UPDATE ingestion_run_current SET approved_at = NULL, approved_candidate_digest = NULL, approved_expected_revision_id = NULL WHERE ingestion_run_id = ?`,
  );
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
    ) VALUES (?, 'retry_ingestion_run', ?, ?, 201, 'success', ?)`);
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
      ) VALUES (?, 'retry_ingestion_run', ?, ?, ?, 'success', ?)`);
}

export function setOperationStateActiveIngestionRunIdForExpiryRepairsDanglingActiveIdentityStillWinsAtDeadline(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(`UPDATE operation_state
    SET active_ingestion_run_id = 'run_dangling_pointer'
    WHERE singleton = 1`);
}

export function setIngestionRunsStateApprovalJson(database: D1Database): D1PreparedStatement {
  return bindFixtureMutation((...values) => {
    const store = catalogueStore(database);
    const event = runEventCommand("approval_reserved", { runId: String(values[9]) });
    return runEventStatement(store, {
      event,
      statement: database
        .prepare(
          `UPDATE ingestion_run_current SET ${runEventIdentitySql}, state='publishing', approved_at=json_extract(?,'$.approved_at'),approved_candidate_digest=json_extract(?,'$.candidate_digest'), approved_expected_revision_id=json_extract(?,'$.expected_current_revision_id'), completed_stage_count=?, publication_revision_id=?,publication_started_at=?,publication_reconcile_after=?,publication_manifest_digest=?,publication_writer_token=? WHERE ingestion_run_id=? AND state='awaiting_approval'`,
        )
        .bind(
          event.eventId,
          values[0],
          values[0],
          values[0],
          runCompletedStageCount(String(values[3])),
          ...values.slice(4),
        ),
      approvalIdempotencyKey: String(values[1]),
      decisionJson: JSON.stringify((JSON.parse(String(values[2])) as unknown[]).at(-1)),
    });
  });
}

export function setIngestionRunsApprovalJson(database: D1Database): D1PreparedStatement {
  return database.prepare(
    `UPDATE ingestion_run_events SET payload_json = '{}' WHERE ingestion_run_id = ? AND event_kind = 'approval_reserved'`,
  );
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
           FROM ingestion_run_read WHERE id = ?`);
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
  return database.prepare(
    `SELECT
       run.state,
       (SELECT COUNT(*) FROM ingestion_publication_cleanup
        WHERE ingestion_run_id = run.id) AS cleanup_count,
       (SELECT current_revision_id FROM catalogue_state
        WHERE singleton = 1) AS current_revision_id
     FROM ingestion_run_read AS run WHERE run.id = ?`,
  );
}

export function readIngestionPublicationCleanupNotBefore(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT not_before FROM ingestion_publication_cleanup
     WHERE ingestion_run_id = ?`);
}

export function insertIngestionRunsForSeedDeletionExport(database: D1Database): D1PreparedStatement {
  return bindRunFixtureStatement(database, (...values) => ({
    id: values[0],
    state: "publishing",
    selected_games_json: '["one-piece"]',
    started_at: values[1],
    expected_current_revision_id: values[2],
    linked_run_id: null,
    idempotency_key: values[3],
    candidate_digest: values[4],
    candidate_created_at: values[5],
    approval_deadline: "2099-01-01T00:00:00.000Z",
    approval_json: values[6],
    published_revision_id: null,
    export_manifest_digest: null,
    terminal_at: null,
    candidate_json: values[7],
    approval_idempotency_key: null,
  }));
}

export function setIngestionRunsStatePublishedRevisionIdForSeedDeletionExport(
  database: D1Database,
): D1PreparedStatement {
  return bindFixtureMutation((...values) => {
    const store = catalogueStore(database);
    const event = runEventCommand("published", { runId: String(values[3]) });
    return runEventStatement(store, {
      event,
      statement: database
        .prepare(`UPDATE ingestion_run_current SET ${runEventIdentitySql}, state = 'published', published_revision_id = ?,
         resulting_revision_id = ?, publication_outcome = 'revision', terminal_at = ?
       WHERE ingestion_run_id = ?`)
        .bind(event.eventId, ...values),
    });
  });
}

export function readIngestionRunsState(database: D1Database): D1PreparedStatement {
  return database.prepare("SELECT state FROM ingestion_run_read WHERE id = ?");
}

export function readIngestionRunsCandidateJson(database: D1Database): D1PreparedStatement {
  return database.prepare("SELECT candidate_json FROM ingestion_run_read WHERE id = ?");
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
  return database.prepare(
    `SELECT COUNT(*) AS count
     FROM ingestion_run_read
     WHERE idempotency_key = 'production-fixture-publication-bypass'`,
  );
}

export function insertIngestionRunsForProductionReleaseSearchFixturesComeFromRealisticRevisionPinned(
  database: D1Database,
): D1PreparedStatement {
  return bindRunFixtureStatement(database, (...values) => ({
    id: "run_release_fixture",
    state: "awaiting_approval",
    selected_games_json: "[]",
    started_at: "2026-08-05T00:00:00.000Z",
    expected_current_revision_id: "catrev_spine_000",
    idempotency_key: "run-release-fixture",
    candidate_digest: values[0],
    approval_deadline: "2099-01-01T00:00:00.000Z",
    candidate_json: "{}",
  }));
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
  return database.prepare(
    `SELECT
       (SELECT COUNT(*) FROM ingestion_run_read
        WHERE idempotency_key = 'blocked-recovery-start') AS runs,
       active_ingestion_run_id
     FROM operation_state
     WHERE singleton = 1`,
  );
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
  return bindFixtureMutation((...values) => {
    const store = catalogueStore(database);
    const event = runEventCommand("failed", { runId: String(values[0]) });
    return runEventStatement(store, {
      event,
      statement: database
        .prepare(
          `UPDATE ingestion_run_current SET ${runEventIdentitySql}, state='failed',terminal_at=(SELECT started_at FROM ingestion_runs WHERE id=ingestion_run_id),failure_code='synthetic_retry_source' WHERE ingestion_run_id=?`,
        )
        .bind(event.eventId, values[0]),
    });
  });
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
  return seedRunFixtureStatement(database, {
    id: "run_future_legality_scope",
    state: "planning",
    selected_games_json: '["gundam"]',
    started_at: "2026-08-02T00:00:00.000Z",
    expected_current_revision_id: "catrev_spine_000",
    linked_run_id: null,
    idempotency_key: "future-legality-scope",
    candidate_json: "{}",
  });
}

export function insertIngestionRunsForAppliedD1RequestCopiesOwningRunIdentitiesAreImmutable(
  database: D1Database,
): D1PreparedStatement {
  return bindRunFixtureStatement(database, (...values) => ({
    id: values[0],
    state: "collecting",
    selected_games_json: '["one-piece"]',
    started_at: "2026-08-01T00:00:00.000Z",
    expected_current_revision_id: "catrev_spine_000",
    linked_run_id: null,
    idempotency_key: values[1],
    candidate_json: "{}",
  }));
}

export function insertIngestionRunsForFreshD1EnforcesFullLowercaseDigestsCanonicalRevisionRule(
  database: D1Database,
): D1PreparedStatement {
  return bindRunFixtureStatement(database, (...values) => ({
    id: "run_upgraded_legality_guard",
    state: "publishing",
    selected_games_json: '["one-piece"]',
    started_at: "2026-08-01T00:00:00.000Z",
    expected_current_revision_id: "catrev_spine_000",
    linked_run_id: null,
    idempotency_key: "upgraded-legality-guard",
    candidate_digest: values[0],
    candidate_created_at: "2026-08-01T00:00:02.000Z",
    approval_deadline: "2099-01-01T00:00:00.000Z",
    approval_json: values[1],
    candidate_json: "{}",
  }));
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
  return bindRunFixtureStatement(database, (...values) => ({
    id: values[0],
    state: "parsing",
    selected_games_json: '["fusion-world"]',
    started_at: "2026-08-03T00:00:00.000Z",
    expected_current_revision_id: "catrev_spine_000",
    linked_run_id: null,
    idempotency_key: values[1],
    candidate_json: "{}",
  }));
}

export function countIngestionRunsCountForUnregisteredGenericCardAdapterCannotSelfAssertOfficialErrata(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(
    `SELECT COUNT(*) AS count FROM ingestion_run_read
       WHERE idempotency_key = 'reject-generic-production-errata-authority'`,
  );
}

export function readRunFixtureForLegacyCandidate(database: D1Database): D1PreparedStatement {
  return database.prepare("SELECT * FROM ingestion_run_read WHERE id = ?");
}
export function insertIngestionRunsForLegacyPersistedCandidatesWithoutErrataRemainInspectableRetryable(
  database: D1Database,
  row: Record<string, unknown>,
): D1PreparedStatement {
  return bindRunFixtureStatement(database, (...values) => ({
    ...row,
    id: values[0],
    state: row.state,
    idempotency_key: values[1],
    candidate_json: values[2],
    linked_run_id: null,
    approval_idempotency_key: null,
  }));
}

export function readIngestionRunsStateTerminalAt(database: D1Database): D1PreparedStatement {
  return database.prepare("SELECT state, terminal_at, failure_code FROM ingestion_run_read WHERE id = ?");
}

export function readIngestionRunsStateFailureCode(database: D1Database): D1PreparedStatement {
  return database.prepare("SELECT state, failure_code FROM ingestion_run_read WHERE id = ?");
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
  return database.prepare("SELECT warnings_json FROM ingestion_run_read WHERE id = ?");
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
  return bindRunFixtureStatement(database, (...values) => ({
    id: values[0],
    state: "publishing",
    selected_games_json: '["one-piece"]',
    started_at: values[1],
    expected_current_revision_id: values[2],
    idempotency_key: values[3],
    candidate_digest: "seed-digest",
    candidate_catalogue_digest: "seed-digest",
    candidate_created_at: values[4],
    approval_deadline: "2099-01-01T00:00:00.000Z",
    candidate_json: values[5],
    approval_json: values[6],
    progress_json: '{"completed_stages":[],"current_stage":"publishing"}',
    warnings_json: "[]",
    approval_history_json: "[]",
  }));
}

export function insertCatalogueRevisionsForCuratedRevisions(database: D1Database): D1PreparedStatement {
  return database.prepare(`INSERT INTO catalogue_revisions (
        id, ingestion_run_id, published_at, content_digest,
        expected_previous_revision_id, approved_candidate_digest
      ) VALUES (?, ?, ?, 'seed-digest', ?, 'seed-digest')`);
}

export function setIngestionRunsStateTerminalAtForCuratedRevisions(database: D1Database): D1PreparedStatement {
  return bindFixtureMutation((...values) => {
    const store = catalogueStore(database);
    const event = runEventCommand("failed", { runId: String(values[0]) });
    return runEventStatement(store, {
      event,
      statement: database
        .prepare(
          `UPDATE ingestion_run_current SET ${runEventIdentitySql},state='failed',terminal_at=COALESCE(candidate_created_at,(SELECT started_at FROM ingestion_runs WHERE id=ingestion_run_id)),failure_code=CASE WHEN state='publishing' THEN 'publication_abandoned' ELSE 'test_cleanup_active_run' END WHERE ingestion_run_id=? AND ingestion_run_id=(SELECT active_ingestion_run_id FROM operation_state WHERE singleton=1) AND state IN ('planning','collecting','parsing','reconciling','awaiting_approval','publishing')`,
        )
        .bind(event.eventId, values[0]),
    });
  });
}

export function setOperationStateRecoveryHealthActiveProductionReleaseId(database: D1Database): D1PreparedStatement {
  return database.prepare(
    "UPDATE operation_state SET recovery_health = 'healthy', active_production_release_id = 'release_active', active_production_release_expires_at = '2099-01-01T00:00:00.000Z' WHERE singleton = 1",
  );
}

export function readIngestionRunsId(database: D1Database): D1PreparedStatement {
  return database.prepare("SELECT id FROM ingestion_run_read WHERE id = ?");
}

export function claimCanonicalReleaseLease(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE operation_state
    SET active_production_release_id = ?1, active_production_release_expires_at = ?2
    WHERE singleton = 1 AND active_ingestion_run_id IS NULL
      AND recovery_health = 'healthy' AND recovery_restore_guard = 'clear' AND active_recovery_id IS NULL
      AND (active_production_release_id IS NULL OR active_production_release_expires_at <= ?3)`);
}

export function clearCanonicalReleaseLease(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE operation_state
    SET active_production_release_id = NULL, active_production_release_expires_at = NULL
    WHERE singleton = 1 AND active_production_release_id = ? AND active_production_release_expires_at = ?`);
}

export function renewCanonicalReleaseLease(database: D1Database): D1PreparedStatement {
  return database.prepare(`UPDATE operation_state SET active_production_release_expires_at = ?1
    WHERE singleton = 1 AND active_production_release_id = ?2
      AND active_production_release_expires_at = ?3 AND active_production_release_expires_at > ?4`);
}

export function readCanonicalReleaseLease(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT active_ingestion_run_id, active_production_release_id,
    active_production_release_expires_at FROM operation_state WHERE singleton = 1`);
}

export function readIngestionRunsCandidateJsonForCandidateInspectionExposesExactPinnedSetEveryCuratedEffect(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare("SELECT candidate_json FROM ingestion_run_read WHERE idempotency_key = ?");
}

export function setIngestionRunsStateProgressJson(database: D1Database): D1PreparedStatement {
  return bindFixtureMutation((...values) => {
    const store = catalogueStore(database);
    const event = runEventCommand("stage_changed", { runId: String(values[0]) });
    return runEventStatement(store, {
      event,
      statement: database
        .prepare(
          `UPDATE ingestion_run_current SET ${runEventIdentitySql}, state='reconciling', completed_stage_count=3 WHERE ingestion_run_id=?`,
        )
        .bind(event.eventId, values[0]),
    });
  });
}

export function setIngestionRunsStateCandidateJson(database: D1Database): D1PreparedStatement {
  return bindFixtureMutation((...values) => {
    const store = catalogueStore(database);
    const event = runEventCommand("candidate_prepared", { runId: String(values[5]) });
    return runEventStatement(store, {
      event,
      statement: database
        .prepare(
          `UPDATE ingestion_run_current SET ${runEventIdentitySql},state='awaiting_approval',candidate_payload_event_sequence=last_event_sequence+1,candidate_digest=?,candidate_catalogue_digest=?,candidate_created_at=?,approval_deadline=?,completed_stage_count=4 WHERE ingestion_run_id=?`,
        )
        .bind(event.eventId, ...values.slice(1)),
      candidateJson: String(values[0]),
    });
  });
}

export function insertIngestionRunsForPreparedRunsStripPriorEffectsReapplyExactPinsPersist(
  database: D1Database,
): D1PreparedStatement {
  return bindRunFixtureStatement(database, (...values) => ({
    id: values[0],
    state: "planning",
    selected_games_json: '["one-piece"]',
    started_at: values[1],
    expected_current_revision_id: values[2],
    idempotency_key: values[3],
    candidate_json: "{}",
    progress_json: '{"completed_stages":[],"current_stage":"planning"}',
    warnings_json: "[]",
    approval_history_json: "[]",
  }));
}

export function readIngestionRunCuratedRevisionSetsRevisionIdsJsonSetDigest(database: D1Database): D1PreparedStatement {
  return database.prepare(`SELECT revision_ids_json, set_digest
     FROM ingestion_run_curated_revision_sets WHERE ingestion_run_id = ?`);
}

export function insertIngestionRunsForPreparedRetryPersistsFailedRunEverySourceChangeConflict(
  database: D1Database,
): D1PreparedStatement {
  return bindRunFixtureStatement(database, (...values) => ({
    id: values[0],
    state: "failed",
    selected_games_json: '["one-piece"]',
    started_at: values[1],
    expected_current_revision_id: values[2],
    idempotency_key: values[3],
    candidate_digest: values[4],
    candidate_catalogue_digest: values[5],
    candidate_created_at: values[6],
    terminal_at: values[7],
    candidate_json: values[8],
    failure_code: "prior_failure",
    progress_json: '{"completed_stages":["planning","collecting","parsing","reconciling"],"current_stage":"failed"}',
    warnings_json: "[]",
    approval_history_json: "[]",
  }));
}

export function setIngestionRunsCandidateJson(database: D1Database): D1PreparedStatement {
  return database.prepare(
    `UPDATE ingestion_run_event_payload_chunks SET content = '{}' WHERE ingestion_run_id = ? AND payload_kind = 'candidate'`,
  );
}

export function insertIngestionRunsForWorkerBindsSourceChangeReaffirmationExactPublicConflict(
  database: D1Database,
): D1PreparedStatement {
  return bindRunFixtureStatement(database, (...values) => ({
    id: values[0],
    state: "failed",
    selected_games_json: '["one-piece"]',
    started_at: values[1],
    expected_current_revision_id: values[2],
    idempotency_key: values[3],
    candidate_digest: values[4],
    candidate_catalogue_digest: values[5],
    candidate_created_at: values[6],
    terminal_at: values[7],
    candidate_json: values[8],
    failure_code: "test_source_changed",
    progress_json: '{"completed_stages":["planning","collecting","parsing","reconciling"],"current_stage":"failed"}',
    warnings_json: "[]",
    approval_history_json: "[]",
  }));
}

export function insertIngestionRunsForWorkerBindsSourceChangeReaffirmationExactPublicConflictWithCompletedStagesPlanningCollectingParsingReconciling(
  database: D1Database,
): D1PreparedStatement {
  return bindRunFixtureStatement(database, (...values) => ({
    id: values[0],
    state: "failed",
    selected_games_json: '["digimon"]',
    started_at: values[1],
    expected_current_revision_id: values[2],
    idempotency_key: values[3],
    candidate_digest: values[4],
    candidate_catalogue_digest: values[5],
    candidate_created_at: values[6],
    terminal_at: values[7],
    candidate_json: values[8],
    failure_code: "test_unaffected_game",
    progress_json: '{"completed_stages":["planning","collecting","parsing","reconciling"],"current_stage":"failed"}',
    warnings_json: "[]",
    approval_history_json: "[]",
  }));
}

export function readIngestionRunsStateFailureCodeForChangedOfficialValueRequiresReconfirmationInsteadSilentlyApplying(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare("SELECT state, failure_code, terminal_at FROM ingestion_run_read WHERE id = ?");
}

export function setIngestionRunsStateTerminalAtForFieldAbsenceDistinctFromNullRetirementRestoresExactAbsence(
  database: D1Database,
): D1PreparedStatement {
  return bindFixtureMutation((...values) => {
    const store = catalogueStore(database);
    const event = runEventCommand("failed", { runId: String(values[1]) });
    return runEventStatement(store, {
      event,
      statement: database
        .prepare(
          `UPDATE ingestion_run_current SET ${runEventIdentitySql}, state='failed',terminal_at=?,failure_code='test_complete' WHERE ingestion_run_id=?`,
        )
        .bind(event.eventId, ...values),
    });
  });
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
  return bindRunFixtureStatement(database, (...values) => ({
    id: values[0],
    state: "parsing",
    selected_games_json: values[1],
    started_at: values[2],
    expected_current_revision_id: values[3],
    idempotency_key: values[4],
    candidate_json: "{}",
    progress_json: '{"completed_stages":["planning","collecting"],"current_stage":"parsing"}',
    warnings_json: "[]",
    approval_history_json: "[]",
  }));
}

export function insertIngestionRunsForPublishedEvidenceDiagnosticsExplicitlyAdvertiseNoRetryRoute(
  database: D1Database,
): D1PreparedStatement {
  return bindRunFixtureStatement(database, (...values) => ({
    id: values[0],
    state: "published",
    selected_games_json: '["one-piece"]',
    started_at: values[1],
    expected_current_revision_id: "catrev_spine_000",
    linked_run_id: null,
    idempotency_key: values[2],
    operational_request_id: values[3],
    terminal_at: values[4],
    candidate_json: "{}",
  }));
}

export function readIngestionRunsStateCandidateDigest(database: D1Database): D1PreparedStatement {
  return database.prepare(
    `SELECT state, candidate_digest, expected_current_revision_id,
              approval_json, approval_idempotency_key,
              published_revision_id, publication_outcome,
              resulting_revision_id
       FROM ingestion_run_read WHERE id = ?`,
  );
}

export function readIngestionRunsCandidateCatalogueDigestContentDigest(database: D1Database): D1PreparedStatement {
  return database.prepare(
    `SELECT run.candidate_catalogue_digest, revision.content_digest
     FROM ingestion_run_read AS run
     JOIN catalogue_revisions AS revision ON revision.id = ?
     WHERE run.id = ?`,
  );
}

export function readIngestionRunsCandidateDigestCandidateCatalogueDigest(database: D1Database): D1PreparedStatement {
  return database.prepare(
    `SELECT run.candidate_digest, run.candidate_catalogue_digest,
            revision.content_digest
     FROM ingestion_run_read AS run
     JOIN catalogue_revisions AS revision ON revision.id = ?
     WHERE run.id = ?`,
  );
}

export function readIngestionRunsStateTerminalAtForReachingRequestCapacityPausesIngestionRunWithoutFailingRetained(
  database: D1Database,
): D1PreparedStatement {
  return database.prepare(
    `SELECT state, terminal_at, failure_code, progress_json
     FROM ingestion_run_read WHERE id = ?`,
  );
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

function bindFixtureMutation(bind: (...values: unknown[]) => D1PreparedStatement): D1PreparedStatement {
  return {
    bind,
    run: () => bind().run(),
    all: () => bind().all(),
    first: (column?: string) => (column === undefined ? bind().first() : bind().first(column)),
    raw: () => bind().raw(),
  } as D1PreparedStatement;
}
