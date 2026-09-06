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
  });
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
    .prepare("SELECT games_json, policy_json FROM entity_admission_run_pins WHERE ingestion_run_id = ?")
    .bind(run);
}
export function pinAdmissionsStatement(database: CatalogueStore, run: string, games: string, policy: string) {
  return atomicRepositoryStatement(database, {
    statement: repositoryStatements(database)
      .prepare("INSERT INTO entity_admission_run_pins (ingestion_run_id, games_json, policy_json) VALUES (?, ?, ?)")
      .bind(run, games, policy),
    before: [identityRunGuard(database, run)],
    after: [
      repositoryStatements(database)
        .prepare(`INSERT INTO entity_admission_pinned_decisions (ingestion_run_id, proposal_id, generation)
      SELECT ?, p.id, COALESCE((SELECT MAX(generation) FROM entity_admission_decisions WHERE proposal_id = p.id), 0)
      FROM entity_proposals p WHERE p.game IN (SELECT value FROM json_each(?))`)
        .bind(run, games),
    ],
  });
}
export function pinnedAdmissionsStatement(database: CatalogueStore, run: string, after: string) {
  return repositoryStatements(database)
    .prepare(`SELECT p.*, d.decision_json, d.action, pin.generation
    FROM entity_admission_pinned_decisions pin JOIN entity_proposals p ON p.id = pin.proposal_id
    LEFT JOIN entity_admission_decisions d ON d.proposal_id = p.id AND d.generation = pin.generation
    WHERE pin.ingestion_run_id = ? AND p.id > ? ORDER BY p.id LIMIT 100`)
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
      (proposal_id, ingestion_run_id, source_snapshot_id, source_observation_id) VALUES (?, ?, ?, ?)
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
export function admissionReplayStatement(database: CatalogueStore, key: string) {
  return repositoryStatements(database)
    .prepare("SELECT * FROM entity_admission_decisions WHERE idempotency_key = ?")
    .bind(key);
}
export function pinnedAdmissionStatement(database: CatalogueStore, run: string, id: string) {
  return repositoryStatements(database)
    .prepare(`SELECT pin.generation, d.* FROM entity_admission_pinned_decisions pin
    LEFT JOIN entity_admission_decisions d ON d.proposal_id = pin.proposal_id AND d.generation = pin.generation
    WHERE pin.ingestion_run_id = ? AND pin.proposal_id = ?`)
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
