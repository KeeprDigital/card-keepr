import { type CatalogueStore, repositoryStatements } from "../shared";

// These are database snapshot records, never a consumer export envelope. One row
// per page bounds retained partition/text buffers, independently of catalogue size.
export const compositionSnapshotTables = [
  "catalogue_revisions",
  "catalogue_exports",
  "catalogue_export_deletion_plans",
  "catalogue_export_deletions",
  "catalogue_export_deletion_tombstones",
  "catalogue_export_deletion_retries",
  "catalogue_composition_games",
  "catalogue_candidate_publications",
  "game_catalogue_heads",
  "catalogue_query_revisions",
  "game_candidates",
  "game_publication_operations",
  "game_publication_actions",
  "publication_preparations",
  "publication_export_preparations",
  "publication_export_components",
  "publication_export_nodes",
  "publication_query_documents",
  "publication_projection_batches",
  "publication_search_chunks",
  "publication_read_entities",
  "publication_read_lifecycles",
  "publication_read_attributes",
  "publication_read_release_regions",
  "publication_read_text_chunks",
  "publication_preparation_artifacts",
  "publication_composition_nodes",
  "verified_publication_compositions",
  "canonical_identity_allocations",
  "canonical_source_mappings",
  "canonical_identity_reviews",
  "canonical_identity_decisions",
  "entity_proposals",
  "entity_admission_decisions",
  "entity_admission_events",
  "entity_proposal_source_evidence",
  "identity_correction_decisions",
  "curated_revisions",
  "curated_revision_events",
  "reconciliation_source_mappings",
  "reconciliation_identity_reviews",
  "reconciliation_curated_pins",
  "reconciliation_automatic_admissions",
  "reconciliation_admission_decisions",
  "reconciliation_correction_pins",
  "reconciliation_evidence_selection",
  "source_snapshots",
  "source_observation_sets",
  "retained_source_observation_evidence",
  "source_requests",
  "source_fetch_attempts",
  "source_authority_decisions",
  "source_lifecycle_decisions",
  "ingestion_runs",
  "ingestion_run_current",
  "ingestion_run_events",
  "ingestion_run_event_payload_chunks",
  "reconciliation_operations",
  "reconciliation_contexts",
  "reconciliation_source_observations",
  "reconciliation_observation_origins",
] as const;
export type CompositionSnapshotTable = (typeof compositionSnapshotTables)[number];
export type CompositionVerificationQuery =
  | { kind: "composition-state"; revisionId: string }
  | { kind: "composition-page"; table: CompositionSnapshotTable; after: number }
  | { kind: "composition-schema"; after: string }
  | { kind: "foreign-keys" };
export function compositionVerificationQuery(input: CompositionVerificationQuery) {
  if (input.kind === "composition-schema")
    return {
      sql: `SELECT name,type,sql FROM sqlite_schema WHERE name>? AND sql IS NOT NULL
      AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE '%_fts%'
      AND name<>'d1_migrations' ORDER BY name LIMIT 1`,
      params: [input.after],
    };
  if (input.kind === "foreign-keys") return { sql: "PRAGMA foreign_key_check", params: [] };
  if (input.kind === "composition-page") {
    if (!compositionSnapshotTables.includes(input.table)) throw new Error("Unknown composition snapshot table.");
    return {
      sql: `SELECT rowid AS snapshot_rowid, * FROM ${input.table} WHERE rowid > ? ORDER BY rowid LIMIT 1`,
      params: [input.after],
    };
  }
  return {
    sql: `SELECT r.id, r.content_digest, r.publication_operation_id, r.ingestion_run_id,
    s.migration_level, o.recovery_restore_guard,
    (SELECT state FROM card_search_fts_state WHERE singleton=1) AS search_state,
    (SELECT count(*) FROM catalogue_composition_games WHERE catalogue_revision_id=r.id) AS members,
    (SELECT count(*) FROM catalogue_composition_games m JOIN publication_query_documents d ON d.candidate_id=m.candidate_id
      WHERE m.catalogue_revision_id=r.id AND d.kind='cards') AS cards,
    (SELECT count(*) FROM catalogue_composition_games m JOIN publication_query_documents d ON d.candidate_id=m.candidate_id
      WHERE m.catalogue_revision_id=r.id AND d.kind='printings') AS printings,
    (SELECT count(*) FROM catalogue_composition_games m JOIN publication_query_documents d ON d.candidate_id=m.candidate_id
      WHERE m.catalogue_revision_id=r.id AND d.kind='products') AS products,
    (SELECT count(*) FROM catalogue_composition_games m JOIN publication_read_entities e ON e.candidate_id=m.candidate_id
      LEFT JOIN publication_read_lifecycles l ON l.candidate_id=e.candidate_id AND l.kind=e.kind AND l.entity_id=e.entity_id
      LEFT JOIN catalogue_candidate_publications first ON first.candidate_id=l.first_candidate_id
      LEFT JOIN catalogue_candidate_publications last ON last.candidate_id=l.last_observed_candidate_id
      LEFT JOIN catalogue_candidate_publications withdrawn ON withdrawn.candidate_id=l.withdrawal_candidate_id
      WHERE m.catalogue_revision_id=r.id AND e.kind IN ('cards','printings','products','relationships','product_relationships')
      AND (l.entity_id IS NULL OR first.candidate_id IS NULL OR last.candidate_id IS NULL
        OR (l.withdrawal_candidate_id IS NOT NULL AND withdrawn.candidate_id IS NULL))) AS missing_lifecycle,
    (SELECT count(*) FROM publication_search_chunks c WHERE NOT EXISTS (
      SELECT 1 FROM publication_search_fts f WHERE f.candidate_id=c.candidate_id AND f.card_id=c.card_id
      AND f.search_text=c.search_text)) AS missing_search
    FROM catalogue_revisions r JOIN catalogue_state h ON h.current_revision_id=r.id
    JOIN catalogue_schema_state s ON s.singleton=1 JOIN operation_state o ON o.singleton=1
    WHERE r.id=?`,
    params: [input.revisionId],
  };
}
export function compositionVerificationStatement(db: CatalogueStore, input: CompositionVerificationQuery) {
  const query = compositionVerificationQuery(input);
  return repositoryStatements(db)
    .prepare(query.sql)
    .bind(...query.params);
}

export function compositionArtifactRootsStatement(db: CatalogueStore, revisionId: string) {
  return repositoryStatements(db)
    .prepare(`SELECT m.supported_game,m.game_revision_id,m.candidate_id,m.root_digest,
 c.preparation_id,c.manifest_digest,p.publication_operation_id,p.revision_id,p.state AS public_state,
 p.root_digest AS public_root_digest,p.root_object_key,p.root_bytes,p.component_count,o.deadline,
 r.content_digest AS composition_digest,v.content AS composition_json
 FROM catalogue_composition_games m JOIN game_candidates c ON c.id=m.candidate_id
 JOIN catalogue_revisions r ON r.id=m.catalogue_revision_id
 LEFT JOIN verified_publication_compositions v ON v.sha256=r.content_digest
 LEFT JOIN publication_export_preparations p ON p.candidate_id=m.candidate_id
 LEFT JOIN game_publication_operations o ON o.id=p.publication_operation_id
 WHERE m.catalogue_revision_id=? ORDER BY m.supported_game LIMIT 5`)
    .bind(revisionId);
}
