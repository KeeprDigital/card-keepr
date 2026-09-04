import {
  curatedOwnerMutationGuardStatement,
  curatedTargetAvailabilityGuardStatement,
  curatedRunPinSetGuardStatement,
} from "./curated-guard-repository";
import {
  atomicRepositoryStatement,
  type CatalogueStore,
  ingestionRunTransitionSql,
  repositoryStatements,
  type SupportedGame,
} from "../shared";

export type CuratedRevisionRow = {
  id: string;
  game: SupportedGame;
  target_key: string;
  proposal_json: string;
  content_digest: string;
  schema_binding_json: string;
  author: string;
  created_at: string;
  status: string;
  event_version: number;
  reviewed_source_digest: string;
};

export function curatedRevisionStatement(database: CatalogueStore, revisionId: string): D1PreparedStatement {
  return repositoryStatements(database).prepare("SELECT * FROM curated_revisions WHERE id = ?").bind(revisionId);
}

export type CuratedLifecycleMutationInput = {
  revisionId: string;
  expectedEventVersion: number;
  status: "active" | "reconfirmation_required" | "superseded" | "retired";
  eventVersion: number;
  kind: "reaffirmed" | "retired";
  eventJson: string;
  observedAt: string;
  idempotencyKey: string;
  requestDigest: string;
  responseJson: string;
};

export function curatedLifecycleMutationStatements(
  database: CatalogueStore,
  input: CuratedLifecycleMutationInput,
): D1PreparedStatement[] {
  return [
    repositoryStatements(database)
      .prepare(
        "UPDATE curated_revisions SET status = ?, event_version = ? WHERE id = ? AND event_version = ? AND status IN ('active', 'reconfirmation_required')",
      )
      .bind(input.status, input.eventVersion, input.revisionId, input.expectedEventVersion),
    atomicRepositoryStatement(database, {
      before: [curatedOwnerMutationGuardStatement(database, { evidenceJson: input.eventJson, evidenceKind: "event" })],
      statement: repositoryStatements(database)
        .prepare(
          `INSERT INTO curated_revision_events (revision_id, event_version, kind, event_json, created_at, author)
         VALUES (?, ?, ?, ?, ?, 'owner')`,
        )
        .bind(input.revisionId, input.eventVersion, input.kind, input.eventJson, input.observedAt),
    }),
    repositoryStatements(database)
      .prepare(
        `INSERT INTO curated_revision_idempotency (idempotency_key, request_digest, response_json, response_status, created_at)
         VALUES (?, ?, ?, 200, ?)`,
      )
      .bind(input.idempotencyKey, input.requestDigest, input.responseJson, input.observedAt),
  ];
}

export function curatedMutationOperationStateStatement(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(database).prepare(
    "SELECT active_ingestion_run_id, active_production_release_id, active_production_release_expires_at, recovery_health FROM operation_state WHERE singleton = 1",
  );
}

export function insertAuthoredCuratedRevisionStatement(
  database: CatalogueStore,
  input: Readonly<{
    revisionId: string;
    game: SupportedGame;
    targetKey: string;
    targetKind: "field" | "relationship";
    effectiveFrom: string | null;
    effectiveTo: string | null;
    proposalJson: string;
    contentDigest: string;
    reviewedSourceDigest: string;
    schemaBindingJson: string;
    observedAt: string;
  }>,
): D1PreparedStatement {
  return atomicRepositoryStatement(database, {
    before: [
      curatedOwnerMutationGuardStatement(database, { evidenceJson: input.schemaBindingJson, evidenceKind: "schema" }),
      curatedTargetAvailabilityGuardStatement(database, input),
    ],
    statement: repositoryStatements(database)
      .prepare(`INSERT INTO curated_revisions (
          id, game, target_key, target_kind, effective_from, effective_to,
          proposal_json, content_digest, reviewed_source_digest,
          schema_binding_json, author, created_at, status, event_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'owner', ?, 'active', 1)`)
      .bind(
        input.revisionId,
        input.game,
        input.targetKey,
        input.targetKind,
        input.effectiveFrom,
        input.effectiveTo,
        input.proposalJson,
        input.contentDigest,
        input.reviewedSourceDigest,
        input.schemaBindingJson,
        input.observedAt,
      ),
  });
}

export function insertCuratedAuthoredEventStatement(
  database: CatalogueStore,
  input: Readonly<{ revisionId: string; eventJson: string; observedAt: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`INSERT INTO curated_revision_events (
          revision_id, event_version, kind, event_json, created_at, author
        ) VALUES (?, 1, 'authored', ?, ?, 'owner')`)
    .bind(input.revisionId, input.eventJson, input.observedAt);
}

export function insertCuratedCreationResponseStatement(
  database: CatalogueStore,
  input: Readonly<{ idempotencyKey: string; requestDigest: string; documentJson: string; observedAt: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`INSERT INTO curated_revision_idempotency (
          idempotency_key, request_digest, response_json, response_status, created_at
        ) VALUES (?, ?, ?, 201, ?)`)
    .bind(input.idempotencyKey, input.requestDigest, input.documentJson, input.observedAt);
}

export function supersedeCuratedRevisionStatement(
  database: CatalogueStore,
  input: Readonly<{ eventVersion: number; revisionId: string; expectedEventVersion: number }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(
      "UPDATE curated_revisions SET status = 'superseded', event_version = ? WHERE id = ? AND event_version = ? AND status IN ('active', 'reconfirmation_required')",
    )
    .bind(input.eventVersion, input.revisionId, input.expectedEventVersion);
}

export function insertCuratedSupersededEventStatement(
  database: CatalogueStore,
  input: Readonly<{ revisionId: string; eventVersion: number; eventJson: string; observedAt: string }>,
): D1PreparedStatement {
  return atomicRepositoryStatement(database, {
    before: [curatedOwnerMutationGuardStatement(database, { evidenceJson: input.eventJson, evidenceKind: "event" })],
    statement: repositoryStatements(database)
      .prepare(`INSERT INTO curated_revision_events (revision_id, event_version, kind, event_json, created_at, author)
         VALUES (?, ?, 'superseded', ?, ?, 'owner')`)
      .bind(input.revisionId, input.eventVersion, input.eventJson, input.observedAt),
  });
}

export function insertCuratedReplacementAuthoredEventStatement(
  database: CatalogueStore,
  input: Readonly<{ revisionId: string; eventJson: string; observedAt: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`INSERT INTO curated_revision_events (revision_id, event_version, kind, event_json, created_at, author)
         VALUES (?, 1, 'authored', ?, ?, 'owner')`)
    .bind(input.revisionId, input.eventJson, input.observedAt);
}

export function insertCuratedReplacementResponseStatement(
  database: CatalogueStore,
  input: Readonly<{ idempotencyKey: string; requestDigest: string; responseJson: string; observedAt: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`INSERT INTO curated_revision_idempotency (idempotency_key, request_digest, response_json, response_status, created_at)
         VALUES (?, ?, ?, 201, ?)`)
    .bind(input.idempotencyKey, input.requestDigest, input.responseJson, input.observedAt);
}

export function filteredCuratedRevisionsStatement(
  database: CatalogueStore,
  input: Readonly<{ game: string | null; target: string | null; status: string | null }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT * FROM curated_revisions
     WHERE (? IS NULL OR game = ?)
       AND (? IS NULL OR target_key = ?)
       AND (? IS NULL OR status = ?)
     ORDER BY created_at, id`)
    .bind(input.game, input.game, input.target, input.target, input.status, input.status);
}

export function curatedPinnedSetStatement(
  database: CatalogueStore,
  input: Readonly<{ runId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare("SELECT revision_ids_json, set_digest FROM ingestion_run_curated_revision_sets WHERE ingestion_run_id = ?")
    .bind(input.runId);
}

export function curatedRunSelectedGamesStatement(
  database: CatalogueStore,
  input: Readonly<{ runId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare("SELECT selected_games_json FROM ingestion_runs WHERE id = ?")
    .bind(input.runId);
}

export function activeCuratedRevisionsStatement(
  database: CatalogueStore,
  input: Readonly<{ gamesJson: string; on: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT revision.id, revision.proposal_json, revision.content_digest,
            revision.event_version,
            COALESCE((
              SELECT json_extract(event.event_json, '$.reviewed_source_digest')
              FROM curated_revision_events AS event
              WHERE event.revision_id = revision.id
                AND event.kind = 'reaffirmed'
              ORDER BY event.event_version DESC LIMIT 1
            ), revision.reviewed_source_digest) AS reviewed_source_digest
     FROM curated_revisions AS revision
     WHERE revision.status = 'active'
       AND revision.game IN (SELECT value FROM json_each(?))
       AND (revision.effective_from IS NULL OR revision.effective_from <= ?)
       AND (revision.effective_to IS NULL OR ? < revision.effective_to)
     ORDER BY revision.id`)
    .bind(input.gamesJson, input.on, input.on);
}

export function markCuratedSourceChangeStatement(
  database: CatalogueStore,
  input: Readonly<{ eventVersion: number; revisionId: string; expectedEventVersion: number }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(
      "UPDATE curated_revisions SET status = 'reconfirmation_required', event_version = ? WHERE id = ? AND status = 'active' AND event_version = ?",
    )
    .bind(input.eventVersion, input.revisionId, input.expectedEventVersion);
}

export function insertCuratedSourceChangeEventStatement(
  database: CatalogueStore,
  input: Readonly<{ revisionId: string; eventVersion: number; eventJson: string; observedAt: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`INSERT INTO curated_revision_events (revision_id, event_version, kind, event_json, created_at, author)
         SELECT ?, ?, 'source_change_detected', ?, ?, 'system'
         WHERE EXISTS (SELECT 1 FROM curated_revisions WHERE id = ? AND status = 'reconfirmation_required' AND event_version = ?)`)
    .bind(
      input.revisionId,
      input.eventVersion,
      input.eventJson,
      input.observedAt,
      input.revisionId,
      input.eventVersion,
    );
}

export function insertCuratedRunPinStatement(
  database: CatalogueStore,
  input: Readonly<{
    runId: string;
    ordinal: number;
    id: string;
    content_digest: string;
    reviewed_source_digest: string;
  }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`INSERT INTO ingestion_run_curated_revisions (
         ingestion_run_id, ordinal, revision_id, content_digest,
         reviewed_source_digest
       ) VALUES (?, ?, ?, ?, ?)`)
    .bind(input.runId, input.ordinal, input.id, input.content_digest, input.reviewed_source_digest);
}

export function insertCuratedRunPinSetStatement(
  database: CatalogueStore,
  input: Readonly<{ runId: string; idsJson: string; setDigest: string; observedAt: string }>,
): D1PreparedStatement {
  return atomicRepositoryStatement(database, {
    before: [curatedRunPinSetGuardStatement(database, input)],
    statement: repositoryStatements(database)
      .prepare(`INSERT INTO ingestion_run_curated_revision_sets (
         ingestion_run_id, revision_ids_json, set_digest, pinned_at
       ) VALUES (?, ?, ?, ?)`)
      .bind(input.runId, input.idsJson, input.setDigest, input.observedAt),
  });
}

export function blockingCuratedRevisionStatement(
  database: CatalogueStore,
  input: Readonly<{ selectedGamesJson: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT id, game FROM curated_revisions
     WHERE status = 'reconfirmation_required'
       AND game IN (SELECT value FROM json_each(?))
     ORDER BY id LIMIT 1`)
    .bind(input.selectedGamesJson);
}

export function pinnedCuratedRevisionsStatement(
  database: CatalogueStore,
  input: Readonly<{ runId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT revision.id, revision.proposal_json, revision.content_digest,
            pin.reviewed_source_digest
     FROM ingestion_run_curated_revisions AS pin
     JOIN curated_revisions AS revision ON revision.id = pin.revision_id
     WHERE pin.ingestion_run_id = ? ORDER BY pin.ordinal`)
    .bind(input.runId);
}

export function failInvalidCuratedCandidateStatement(
  database: CatalogueStore,
  input: Readonly<{ observedAt: string; runId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE ingestion_runs
         SET state = 'failed', terminal_at = ?,
             failure_code = 'curated_revision_composed_candidate_invalid',
             progress_json = json_set(progress_json, '$.current_stage', 'failed')
         WHERE id = ? AND ${ingestionRunTransitionSql(["planning", "collecting", "parsing", "reconciling", "awaiting_approval"], "failed")}`)
    .bind(input.observedAt, input.runId);
}

export function releaseCuratedRunStatement(
  database: CatalogueStore,
  input: Readonly<{ runId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE operation_state SET active_ingestion_run_id = NULL
         WHERE singleton = 1 AND active_ingestion_run_id = ?`)
    .bind(input.runId);
}

export function curatedRevisionSetStatement(
  database: CatalogueStore,
  input: Readonly<{ runId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT revision_ids_json, set_digest
     FROM ingestion_run_curated_revision_sets
     WHERE ingestion_run_id = ?`)
    .bind(input.runId);
}

export function curatedRunStateStatement(
  database: CatalogueStore,
  input: Readonly<{ runId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare("SELECT state, failure_code FROM ingestion_runs WHERE id = ?")
    .bind(input.runId);
}

export function curatedRunPinInspectionStatement(
  database: CatalogueStore,
  input: Readonly<{ runId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT pin.ordinal, pin.revision_id, pin.content_digest,
            revision.proposal_json
     FROM ingestion_run_curated_revisions AS pin
     JOIN curated_revisions AS revision ON revision.id = pin.revision_id
     WHERE pin.ingestion_run_id = ? ORDER BY pin.ordinal`)
    .bind(input.runId);
}

export function insertPublishedCuratedProvenanceStatement(
  database: CatalogueStore,
  input: Readonly<{ revisionId: string; runId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`INSERT OR IGNORE INTO catalogue_curated_provenance (
       catalogue_revision_id, curated_revision_id, target_key,
       content_digest, provenance_json
     )
     SELECT ?, prior.curated_revision_id, prior.target_key,
            prior.content_digest, prior.provenance_json
     FROM ingestion_runs AS run
     JOIN catalogue_curated_provenance AS prior
       ON prior.catalogue_revision_id = run.expected_current_revision_id
     JOIN curated_revisions AS prior_revision
       ON prior_revision.id = prior.curated_revision_id
     WHERE run.id = ?
       AND NOT EXISTS (
         SELECT 1 FROM json_each(run.selected_games_json)
         WHERE value = prior_revision.game
       )
     UNION ALL
     SELECT ?, revision.id, revision.target_key,
            revision.content_digest,
            json_object(
              'author', revision.author,
              'created_at', revision.created_at,
              'evidence', json_extract(revision.proposal_json, '$.evidence'),
              'rationale', json_extract(revision.proposal_json, '$.rationale')
            )
     FROM ingestion_run_curated_revisions AS pin
     JOIN curated_revisions AS revision ON revision.id = pin.revision_id
     WHERE pin.ingestion_run_id = ?`)
    .bind(input.revisionId, input.runId, input.revisionId, input.runId);
}

export function curatedSchemaAvailableStatement(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(database).prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'curated_revisions'",
  );
}

export function curatedRevisionStatusStatement(
  database: CatalogueStore,
  input: Readonly<{ revisionId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare("SELECT status, event_version FROM curated_revisions WHERE id = ?")
    .bind(input.revisionId);
}

export function markActiveCuratedSourceChangeStatement(
  database: CatalogueStore,
  input: Readonly<{ eventVersion: number; revisionId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(
      "UPDATE curated_revisions SET status = 'reconfirmation_required', event_version = ? WHERE id = ? AND status = 'active'",
    )
    .bind(input.eventVersion, input.revisionId);
}

export function insertLegacyCuratedSourceChangeEventStatement(
  database: CatalogueStore,
  input: Readonly<{ revisionId: string; eventVersion: number; eventJson: string; observedAt: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`INSERT INTO curated_revision_events (revision_id, event_version, kind, event_json, created_at, author)
         SELECT ?, ?, 'source_change_detected', ?, ?, 'system'
         WHERE EXISTS (SELECT 1 FROM curated_revisions WHERE id = ? AND status = 'reconfirmation_required' AND event_version = ?)`)
    .bind(
      input.revisionId,
      input.eventVersion,
      input.eventJson,
      input.observedAt,
      input.revisionId,
      input.eventVersion,
    );
}

export function failCuratedSourceChangeRunStatement(
  database: CatalogueStore,
  input: Readonly<{ at: string; runId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`UPDATE ingestion_runs
       SET state = 'failed', terminal_at = ?,
           failure_code = 'curated_revision_reconfirmation_required',
           progress_json = json_set(progress_json, '$.current_stage', 'failed')
       WHERE id = ? AND ${ingestionRunTransitionSql(["planning", "collecting", "parsing", "reconciling", "awaiting_approval"], "failed")}`)
    .bind(input.at, input.runId);
}

export function curatedPendingConflictStatement(
  database: CatalogueStore,
  input: Readonly<{ id: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT event_json FROM curated_revision_events
     WHERE revision_id = ? AND kind = 'source_change_detected'
     ORDER BY event_version DESC LIMIT 1`)
    .bind(input.id);
}

export function curatedIdempotencyReplayStatement(
  database: CatalogueStore,
  input: Readonly<{ key: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare("SELECT request_digest, response_json FROM curated_revision_idempotency WHERE idempotency_key = ?")
    .bind(input.key);
}

export function curatedReaffirmedSourceDigestStatement(
  database: CatalogueStore,
  input: Readonly<{ revisionId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT json_extract(event_json, '$.reviewed_source_digest') AS digest
     FROM curated_revision_events
     WHERE revision_id = ? AND kind = 'reaffirmed'
     ORDER BY event_version DESC LIMIT 1`)
    .bind(input.revisionId);
}

export function curatedRevisionEventHistoryStatement(
  database: CatalogueStore,
  input: Readonly<{ id: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(
      "SELECT kind, event_version, event_json, created_at, author FROM curated_revision_events WHERE revision_id = ? ORDER BY event_version",
    )
    .bind(input.id);
}

export function curatedCurrentCatalogueRevisionStatement(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(database).prepare("SELECT current_revision_id FROM catalogue_state WHERE singleton = 1");
}

export function curatedCardDocumentStatement(
  database: CatalogueStore,
  input: Readonly<{ revisionId: string; cardId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare("SELECT document_json FROM revision_cards WHERE catalogue_revision_id = ? AND card_id = ?")
    .bind(input.revisionId, input.cardId);
}

export function curatedCatalogueCandidateStatement(
  database: CatalogueStore,
  input: Readonly<{ revisionId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT run.id AS ingestion_run_id, run.candidate_json FROM catalogue_revisions AS revision
     JOIN ingestion_runs AS run ON run.id = revision.ingestion_run_id
     WHERE revision.id = ?`)
    .bind(input.revisionId);
}

export function curatedCatalogueCardDocumentsStatement(
  database: CatalogueStore,
  input: Readonly<{ revisionId: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT document_json FROM revision_cards
     WHERE catalogue_revision_id = ? ORDER BY card_id`)
    .bind(input.revisionId);
}

export function retainedCuratedObservationEvidenceStatement(
  database: CatalogueStore,
  input: Readonly<{ sourceObservationIdsJson: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`SELECT source_observation_id
     FROM retained_source_observation_evidence
     WHERE source_observation_id IN (SELECT value FROM json_each(?))`)
    .bind(input.sourceObservationIdsJson);
}

export function curatedEntityDocumentStatement(
  database: CatalogueStore,
  input: Readonly<{ revisionId: string; entityType: "card" | "printing"; entityId: string }>,
): D1PreparedStatement {
  const table = input.entityType === "card" ? "revision_cards" : "revision_printings";
  const idColumn = input.entityType === "card" ? "card_id" : "printing_id";
  return repositoryStatements(database)
    .prepare(`SELECT document_json FROM ${table} WHERE catalogue_revision_id = ? AND ${idColumn} = ?`)
    .bind(input.revisionId, input.entityId);
}
