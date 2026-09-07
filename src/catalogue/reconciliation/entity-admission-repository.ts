import { identityRunGuard } from "./canonical-identity-repository";
import { type CatalogueStore, canonicalJson, repositoryStatements, atomicRepositoryStatement } from "../shared";

export type EntityProposalRow = {
  id: string;
  game: string;
  source_lineage: string;
  reference: string;
  content_json: string;
  evidence_json: string;
  idempotency_key: string;
  request_json: string;
  created_at: string;
};
export type AdmissionDecisionRow = {
  proposal_id: string;
  generation: number;
  action: string;
  actor: string;
  rationale: string;
  decision_json: string;
  idempotency_key: string;
  request_json: string;
  decided_at: string;
};
export function proposalStatement(database: CatalogueStore, id: string) {
  return repositoryStatements(database).prepare("SELECT * FROM entity_proposals WHERE id = ?").bind(id);
}
export function proposalReplayStatement(database: CatalogueStore, key: string) {
  return repositoryStatements(database).prepare("SELECT * FROM entity_proposals WHERE idempotency_key = ?").bind(key);
}
export function proposalHistoryStatement(database: CatalogueStore, id: string, after = 0) {
  return repositoryStatements(database)
    .prepare(
      "SELECT * FROM entity_admission_decisions WHERE proposal_id = ? AND generation > ? ORDER BY generation LIMIT 101",
    )
    .bind(id, after);
}
export function insertProposalStatement(database: CatalogueStore, row: EntityProposalRow, run?: string) {
  return atomicRepositoryStatement(database, {
    statement: repositoryStatements(database)
      .prepare(`INSERT INTO entity_proposals
      (id, game, source_lineage, reference, content_json, evidence_json, idempotency_key, request_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        row.id,
        row.game,
        row.source_lineage,
        row.reference,
        row.content_json,
        row.evidence_json,
        row.idempotency_key,
        row.request_json,
        row.created_at,
      ),
    before: [run ? identityRunGuard(database, run) : admissionIdleGuard(database)],
    after: [admissionEventStatement(database, row.id, 0)],
  });
}
export type AdmissionIdentityAllocation = { key: string; id: string; kind: "card" | "printing" };
export function insertAdmissionDecisionStatement(
  database: CatalogueStore,
  row: AdmissionDecisionRow,
  run?: string,
  allocations: readonly AdmissionIdentityAllocation[] = [],
) {
  const allocation = allocations.map((item) =>
    repositoryStatements(database)
      .prepare(`INSERT INTO canonical_identity_allocations
    (allocation_key, entity_id, entity_kind, allocated_at) VALUES (?, ?, ?, ?)`)
      .bind(item.key, item.id, item.kind, row.decided_at),
  );
  return atomicRepositoryStatement(database, {
    statement: repositoryStatements(database)
      .prepare(`INSERT INTO entity_admission_decisions
      (proposal_id, generation, action, actor, rationale, decision_json, idempotency_key, request_json, decided_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        row.proposal_id,
        row.generation,
        row.action,
        row.actor,
        row.rationale,
        row.decision_json,
        row.idempotency_key,
        row.request_json,
        row.decided_at,
      ),
    before: [
      run ? identityRunGuard(database, run) : admissionIdleGuard(database),
      ...allocation,
      repositoryStatements(database)
        .prepare(`SELECT CASE WHEN
      ? = 1 + COALESCE((SELECT MAX(generation) FROM entity_admission_decisions WHERE proposal_id = ?), 0)
      THEN 1 ELSE json_extract('{}', 'admission_generation_conflict') END`)
        .bind(row.generation, row.proposal_id),
    ],
    after: [admissionEventStatement(database, row.proposal_id, row.generation)],
  });
}
function admissionEventStatement(database: CatalogueStore, proposalId: string, generation: number) {
  return repositoryStatements(database)
    .prepare("INSERT INTO entity_admission_events (proposal_id, generation) VALUES (?, ?)")
    .bind(proposalId, generation);
}
function admissionIdleGuard(database: CatalogueStore) {
  return repositoryStatements(database).prepare(`SELECT CASE WHEN EXISTS (
    SELECT 1 FROM operation_state WHERE singleton = 1 AND (active_ingestion_run_id IS NOT NULL OR recovery_health = 'blocked'
      OR (active_production_release_id IS NOT NULL AND active_production_release_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))))
    THEN json_extract('{}', 'admission_operation_not_idle') ELSE 1 END`);
}

export function admissionEntityStatement(database: CatalogueStore, kind: "card" | "printing", id: string) {
  const table = kind === "card" ? "revision_cards" : "revision_printings";
  const column = kind === "card" ? "card_id" : "printing_id";
  return repositoryStatements(database)
    .prepare(`SELECT document_json FROM ${table}
    WHERE catalogue_revision_id = (SELECT current_revision_id FROM catalogue_state WHERE singleton = 1) AND ${column} = ?`)
    .bind(id);
}
export function admissionPinStatement(database: CatalogueStore, run: string) {
  return repositoryStatements(database)
    .prepare(
      `SELECT pin.games_json, pin.policy_json, pin.decision_cutoff, operation.supported_game
       FROM reconciliation_admission_pins AS pin JOIN reconciliation_operations AS operation ON operation.id = pin.preparation_id
       WHERE pin.preparation_id = ?`,
    )
    .bind(run);
}
export function pinAdmissionsStatement(database: CatalogueStore, run: string, games: string, policy: string) {
  return atomicRepositoryStatement(database, {
    statement: repositoryStatements(database)
      .prepare(`INSERT INTO reconciliation_admission_pins
        (preparation_id, games_json, policy_json, decision_cutoff, legacy_selection_run_id)
        SELECT operation.id, COALESCE(legacy.games_json, ?), COALESCE(legacy.policy_json, ?),
          CASE WHEN legacy.ingestion_run_id IS NULL
            THEN (SELECT COALESCE(MAX(sequence), 0) FROM entity_admission_events) ELSE NULL END,
          legacy.ingestion_run_id
        FROM reconciliation_operations AS operation LEFT JOIN entity_admission_run_pins AS legacy
          ON operation.supported_game IS NULL AND legacy.ingestion_run_id = operation.ingestion_run_id
        WHERE operation.id = ?`)
      .bind(games, policy, run),
    before: [
      identityRunGuard(database, run),
      repositoryStatements(database)
        .prepare(`SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM entity_admission_run_pins AS legacy
          WHERE operation.supported_game IS NULL AND legacy.ingestion_run_id = operation.ingestion_run_id)
        AND EXISTS (SELECT 1 FROM json_each(?2, '$.authorities') AS authority
          WHERE json_extract(authority.value, '$.generation') <> COALESCE((
            SELECT MAX(decision.generation) FROM source_authority_decisions AS decision
            WHERE decision.game = json_extract(authority.value, '$.game')
              AND decision.locale = json_extract(authority.value, '$.locale')
              AND decision.release_region = json_extract(authority.value, '$.release_region')
              AND decision.area = json_extract(authority.value, '$.area')
              AND decision.rowid <= operation.authority_decision_cutoff), 0))
        THEN json_extract('{}', 'reconciliation_policy_changed') ELSE 1 END
        FROM reconciliation_operations AS operation WHERE operation.id = ?1`)
        .bind(run, policy),
    ],
  });
}
export function admissionSelectionPageStatement(database: CatalogueStore, run: string, after: number) {
  return repositoryStatements(database)
    .prepare(`SELECT event.sequence, event.proposal_id,
      CASE WHEN event.generation = 0 AND p.game IN (SELECT value FROM json_each(pin.games_json))
        THEN (SELECT chosen.generation FROM entity_admission_events chosen
          WHERE chosen.proposal_id = event.proposal_id AND chosen.sequence <= pin.decision_cutoff
          ORDER BY chosen.sequence DESC LIMIT 1)
        ELSE NULL END AS generation
      FROM reconciliation_admission_pins pin JOIN entity_admission_events event
        ON event.sequence > ? AND event.sequence <= pin.decision_cutoff
      JOIN entity_proposals p ON p.id = event.proposal_id
      WHERE pin.preparation_id = ? ORDER BY event.sequence LIMIT 50`)
    .bind(after, run);
}
export function retainAdmissionSelectionStatement(
  database: CatalogueStore,
  run: string,
  proposal: string,
  generation: number,
) {
  return repositoryStatements(database)
    .prepare(`INSERT INTO reconciliation_admission_decisions (preparation_id, proposal_id, generation)
      VALUES (?, ?, ?) ON CONFLICT(preparation_id, proposal_id) DO NOTHING`)
    .bind(run, proposal, generation);
}
export function admissionSelectionReceiptStatement(database: CatalogueStore, run: string, proposals: string[]) {
  return repositoryStatements(database)
    .prepare(`SELECT proposal_id, generation FROM reconciliation_selected_admissions
      WHERE preparation_id = ? AND proposal_id IN (SELECT value FROM json_each(?)) ORDER BY proposal_id`)
    .bind(run, canonicalJson(proposals));
}
export function pinnedAdmissionsStatement(database: CatalogueStore, run: string, after: string) {
  return repositoryStatements(database)
    .prepare(`SELECT p.id, p.source_lineage, d.decision_json, d.action, pin.generation
    FROM reconciliation_selected_admissions pin JOIN entity_proposals p ON p.id = pin.proposal_id
    LEFT JOIN entity_admission_decisions d ON d.proposal_id = p.id AND d.generation = pin.generation
    WHERE pin.preparation_id = ? AND p.id > ? ORDER BY p.id LIMIT 1`)
    .bind(run, after);
}

export function proposalReferenceStatement(database: CatalogueStore, lineage: string, reference: string) {
  return repositoryStatements(database)
    .prepare("SELECT * FROM entity_proposals WHERE source_lineage = ? AND reference = ?")
    .bind(lineage, reference);
}
export function proposalsStatement(database: CatalogueStore, game: string, after: string) {
  return repositoryStatements(database)
    .prepare("SELECT id FROM entity_proposals WHERE game = ? AND id > ? ORDER BY id LIMIT 101")
    .bind(game, after);
}
export function retainProposalEvidenceStatement(
  database: CatalogueStore,
  proposalId: string,
  run: string,
  snapshot: string,
  observation: string,
) {
  return atomicRepositoryStatement(database, {
    statement: repositoryStatements(database)
      .prepare(`INSERT INTO entity_proposal_source_evidence
      (proposal_id, ingestion_run_id, source_snapshot_id, source_observation_id) VALUES (?, (SELECT ingestion_run_id FROM reconciliation_operations WHERE id = ?), ?, ?)
      ON CONFLICT(proposal_id, ingestion_run_id, source_observation_id) DO NOTHING`)
      .bind(proposalId, run, snapshot, observation),
    before: [identityRunGuard(database, run)],
  });
}

export function latestAdmissionStatement(database: CatalogueStore, id: string) {
  return repositoryStatements(database)
    .prepare("SELECT * FROM entity_admission_decisions WHERE proposal_id = ? ORDER BY generation DESC LIMIT 1")
    .bind(id);
}

/** New native proposals may replay only this preparation's own automatic decision. */
export function unselectedSourceAdmissionStatement(
  database: CatalogueStore,
  preparationId: string,
  proposalId: string,
) {
  return repositoryStatements(database)
    .prepare(`SELECT decision.proposal_id, decision.generation, 'admit' AS action, 'automation' AS actor,
      decision.rationale, decision.decision_json,
      'auto_' || decision.preparation_id || '_' || decision.proposal_id AS idempotency_key,
      decision.decision_json AS request_json, decision.decided_at
      FROM reconciliation_automatic_admissions AS decision
      WHERE decision.preparation_id = ?1 AND decision.proposal_id = ?2
      UNION ALL
      SELECT * FROM (SELECT decision.* FROM entity_admission_decisions AS decision
        WHERE decision.proposal_id = ?2 AND EXISTS (SELECT 1 FROM reconciliation_operations
          WHERE id = ?1 AND supported_game IS NULL)
        ORDER BY decision.generation DESC LIMIT 1)
      LIMIT 1`)
    .bind(preparationId, proposalId);
}

/** A later owner decision is kept globally; the preparation retains its own fixed automatic result. */
export function retainNativeAutomaticAdmissionStatement(
  database: CatalogueStore,
  preparationId: string,
  row: AdmissionDecisionRow,
) {
  return atomicRepositoryStatement(database, {
    before: [identityRunGuard(database, preparationId)],
    statement: repositoryStatements(database)
      .prepare(`INSERT INTO reconciliation_automatic_admissions
        (preparation_id, proposal_id, generation, decision_json, rationale, decided_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(preparation_id, proposal_id) DO NOTHING`)
      .bind(preparationId, row.proposal_id, row.generation, row.decision_json, row.rationale, row.decided_at),
    after: [
      repositoryStatements(database)
        .prepare(`INSERT INTO entity_admission_decisions
          (proposal_id, generation, action, actor, rationale, decision_json, idempotency_key, request_json, decided_at)
          SELECT proposal_id, generation, 'admit', 'automation', rationale, decision_json,
            'auto_' || preparation_id || '_' || proposal_id, decision_json, decided_at
          FROM reconciliation_automatic_admissions AS decision
          WHERE preparation_id = ? AND proposal_id = ? AND generation = 1 + COALESCE(
            (SELECT MAX(existing.generation) FROM entity_admission_decisions AS existing WHERE existing.proposal_id = decision.proposal_id), 0)`)
        .bind(preparationId, row.proposal_id),
      repositoryStatements(database)
        .prepare(`INSERT INTO entity_admission_events (proposal_id, generation)
          SELECT proposal_id, generation FROM entity_admission_decisions WHERE idempotency_key = ?
          ON CONFLICT(proposal_id, generation) DO NOTHING`)
        .bind(row.idempotency_key),
    ],
  });
}
export function admissionReplayStatement(database: CatalogueStore, key: string) {
  return repositoryStatements(database)
    .prepare("SELECT * FROM entity_admission_decisions WHERE idempotency_key = ?")
    .bind(key);
}
export function pinnedAdmissionStatement(database: CatalogueStore, run: string, id: string) {
  return repositoryStatements(database)
    .prepare(`SELECT pin.generation, d.* FROM reconciliation_selected_admissions pin
    LEFT JOIN entity_admission_decisions d ON d.proposal_id = pin.proposal_id AND d.generation = pin.generation
    WHERE pin.preparation_id = ? AND pin.proposal_id = ?`)
    .bind(run, id);
}

export function admissionCardIdentityStatement(database: CatalogueStore, game: string, identity: string) {
  return repositoryStatements(database)
    .prepare(`SELECT card_id AS id FROM revision_cards
    WHERE catalogue_revision_id = (SELECT current_revision_id FROM catalogue_state WHERE singleton = 1)
      AND json_extract(document_json, '$.data.game') = ? AND json_extract(document_json, '$.data.official_identity') = json(?)
    UNION SELECT json_extract(d.decision_json, '$.card.id') AS id FROM entity_admission_decisions d
      WHERE d.action IN ('admit', 'link') AND d.generation = (SELECT MAX(generation) FROM entity_admission_decisions WHERE proposal_id = d.proposal_id)
      AND json_extract(d.decision_json, '$.card.game') = ? AND json_extract(d.decision_json, '$.card.official_identity') = json(?) LIMIT 2`)
    .bind(game, identity, game, identity);
}

export function proposalSourceEvidenceStatement(database: CatalogueStore, id: string, after: string) {
  return repositoryStatements(database)
    .prepare(`SELECT ingestion_run_id, source_snapshot_id, source_observation_id
    FROM entity_proposal_source_evidence WHERE proposal_id = ? AND source_observation_id > ?
    ORDER BY source_observation_id LIMIT 101`)
    .bind(id, after);
}

export function latestProposalIntakeStatement(database: CatalogueStore, id: string) {
  return repositoryStatements(database)
    .prepare(`SELECT decision_json FROM entity_admission_decisions
    WHERE proposal_id = ? AND action = 'reconsider' AND json_type(decision_json, '$.content') = 'object'
    ORDER BY generation DESC LIMIT 1`)
    .bind(id);
}
export function latestAcceptedAdmissionStatement(database: CatalogueStore, id: string) {
  return repositoryStatements(database)
    .prepare(`SELECT * FROM entity_admission_decisions
    WHERE proposal_id = ? AND action IN ('admit', 'link') ORDER BY generation DESC LIMIT 1`)
    .bind(id);
}

export function admissionPinMetadataPageStatement(database: CatalogueStore, run: string, after: string) {
  return repositoryStatements(database)
    .prepare(`SELECT proposal_id, generation FROM reconciliation_selected_admissions
    WHERE preparation_id = ? AND proposal_id > ? ORDER BY proposal_id LIMIT 100`)
    .bind(run, after);
}
