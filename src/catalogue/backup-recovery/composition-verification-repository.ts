import { type CatalogueStore, repositoryStatements } from "../shared";

// Pages bound database snapshot metadata independently of consumer export envelopes.
export const maximumSnapshotPageRows = 16;
export const maximumSnapshotPageBytes = 1_048_576;
export const maximumSchemaSnapshotPageRows = 32;
export const maximumSchemaSnapshotPageBytes = 1_048_576;
export const compositionSnapshotTables = [
  "catalogue_revisions",
  "catalogue_exports",
  "catalogue_export_deletion_plans",
  "catalogue_export_deletions",
  "catalogue_export_deletion_tombstones",
  "catalogue_export_deletion_retries",
  "catalogue_composition_games",
  "catalogue_candidate_publications",
  "game_candidate_semantic_receipts",
  "game_candidate_predecessors",
  "game_accepted_candidates",
  "catalogue_acceptance_head",
  "game_catalogue_heads",
  "catalogue_query_revisions",
  "game_candidates",
  "game_candidate_partitions",
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
  "staging_objects",
  "staging_object_writes",
  "staging_object_deletes",
  "evidence_cleanup_operations",
  "evidence_cleanup_objects",
  "evidence_cleanup_results",
  "evidence_object_writers",
  "evidence_object_references",
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
  "reconciliation_checkpoints",
  "reconciliation_reducer_state",
  "reconciliation_text_chunks",
  "reconciliation_source_observations",
  "reconciliation_observation_origins",
] as const;
export type CompositionSnapshotTable = (typeof compositionSnapshotTables)[number];
export type CompositionVerificationQuery =
  | { kind: "composition-state"; revisionId: string }
  | { kind: "composition-columns"; table: CompositionSnapshotTable }
  | { kind: "composition-page"; table: CompositionSnapshotTable; after: number; columns: readonly string[] }
  | { kind: "composition-schema"; after: string }
  | { kind: "composition-accepted-roots" }
  | { kind: "foreign-keys" };
export function compositionVerificationQuery(input: CompositionVerificationQuery) {
  if (input.kind === "composition-accepted-roots") return acceptedEvidenceArtifactRootsQuery();
  if (input.kind === "composition-schema")
    return {
      sql: `WITH page AS (
        SELECT name,type,sql FROM sqlite_schema WHERE name>? AND sql IS NOT NULL
        AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE '%_fts%'
        AND name<>'d1_migrations' ORDER BY name LIMIT ${maximumSchemaSnapshotPageRows}
      ), sizes AS (
        SELECT name,sum(length(CAST(json_object('name',name,'type',type,'sql',sql) AS BLOB)))
          OVER (ORDER BY name) AS page_bytes FROM page
      ) SELECT page.name,page.type,page.sql FROM page JOIN sizes USING(name)
        WHERE sizes.page_bytes<=${maximumSchemaSnapshotPageBytes} OR page.name=(SELECT min(name) FROM page)
        ORDER BY page.name`,
      params: [input.after],
    };
  if (input.kind === "foreign-keys") return { sql: "PRAGMA foreign_key_check", params: [] };
  if (input.kind === "composition-columns" || input.kind === "composition-page") {
    if (!compositionSnapshotTables.includes(input.table)) throw new Error("Unknown composition snapshot table.");
    if (input.kind === "composition-columns")
      return { sql: "SELECT name FROM pragma_table_info(?) ORDER BY cid", params: [input.table] };
    if (
      !input.columns.length ||
      input.columns.length > 128 ||
      new Set(input.columns).size !== input.columns.length ||
      input.columns.some((column) => !/^[a-z_][a-z0-9_]*$/.test(column) || column === "snapshot_rowid")
    )
      throw new Error("Invalid composition snapshot columns.");
    const fields = ["snapshot_rowid", ...input.columns].map((column) => `'${column}',"${column}"`).join(",");
    return {
      sql: `WITH page AS (SELECT rowid AS snapshot_rowid,* FROM ${input.table} WHERE rowid>? ORDER BY rowid LIMIT ${maximumSnapshotPageRows}),
        sizes AS (SELECT snapshot_rowid,sum(length(CAST(json_object(${fields}) AS BLOB))) OVER (ORDER BY snapshot_rowid) AS page_bytes FROM page)
        SELECT page.* FROM page JOIN sizes USING(snapshot_rowid)
        WHERE sizes.page_bytes<=${maximumSnapshotPageBytes} OR page.snapshot_rowid=(SELECT min(snapshot_rowid) FROM page)
        ORDER BY page.snapshot_rowid`,
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
    .prepare(
      `SELECT m.supported_game,m.game_revision_id,m.candidate_id,m.root_digest,
 c.preparation_id,c.manifest_digest,p.publication_operation_id,p.revision_id,p.state AS public_state,
 p.root_digest AS public_root_digest,p.root_object_key,p.root_bytes,p.component_count,o.deadline,
 r.content_digest AS composition_digest,v.content AS composition_json
 FROM catalogue_composition_games m JOIN game_candidates c ON c.id=m.candidate_id
 JOIN catalogue_revisions r ON r.id=m.catalogue_revision_id
 LEFT JOIN verified_publication_compositions v ON v.sha256=r.content_digest
 LEFT JOIN publication_export_preparations p ON p.candidate_id=m.candidate_id
 LEFT JOIN game_publication_operations o ON o.id=p.publication_operation_id
 WHERE m.catalogue_revision_id=? ORDER BY m.supported_game LIMIT 5`,
    )
    .bind(revisionId);
}

export type AcceptedEvidenceArtifactRoot = {
  supported_game: string;
  candidate_id: string;
  preparation_id: string;
  manifest_digest: string;
  root_digest: string;
};

function acceptedEvidenceArtifactRootsQuery() {
  return {
    sql: `SELECT head.supported_game,candidate.id AS candidate_id,
    candidate.preparation_id,candidate.manifest_digest,prepared.root_digest
    FROM game_accepted_candidates head JOIN game_candidates candidate ON candidate.id=head.candidate_id
    LEFT JOIN publication_preparations prepared ON prepared.candidate_id=candidate.id
      AND prepared.state='verified' AND prepared.manifest_digest=candidate.manifest_digest
      AND prepared.generation=candidate.generation
    WHERE candidate.state='published' ORDER BY head.supported_game LIMIT 5`,
    params: [],
  };
}

/** At most one current accepted private root per supported game, including same-revision evidence. */
export function acceptedEvidenceArtifactRootsStatement(db: CatalogueStore) {
  return repositoryStatements(db).prepare(acceptedEvidenceArtifactRootsQuery().sql);
}
