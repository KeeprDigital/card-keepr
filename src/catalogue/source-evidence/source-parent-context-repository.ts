import { type CatalogueStore, repositoryStatements } from "../shared";

export function parseContextStatement(db: CatalogueStore, operation: string) {
  return repositoryStatements(db)
    .prepare(
      `SELECT dependency_count,maximum_context_bytes
    FROM source_parse_contexts WHERE parse_operation_id=?`,
    )
    .bind(operation);
}

export function retainedContextParentsStatement(db: CatalogueStore, operation: string) {
  return repositoryStatements(db)
    .prepare(
      `SELECT s.*,d.ordinal,r.request_role,r.discovered_from_request_id
    FROM source_parse_dependencies d JOIN source_snapshots s ON s.id=d.parent_source_snapshot_id
    JOIN source_requests r ON r.ingestion_run_id=s.ingestion_run_id AND r.request_id=s.request_id
    WHERE d.parse_operation_id=? ORDER BY d.ordinal LIMIT 4`,
    )
    .bind(operation);
}

export function retainContextParentStatement(db: CatalogueStore, operation: string, ordinal: number, parent: string) {
  return repositoryStatements(db)
    .prepare(
      `INSERT INTO source_parse_dependencies
    (parse_operation_id,ordinal,parent_source_snapshot_id)
    SELECT ?,?,? WHERE NOT EXISTS(SELECT 1 FROM source_parse_contexts WHERE parse_operation_id=?)
    ON CONFLICT DO NOTHING`,
    )
    .bind(operation, ordinal, parent, operation);
}

export function sealParseContextStatement(db: CatalogueStore, operation: string, count: number, maximumBytes: number) {
  return repositoryStatements(db)
    .prepare(
      `INSERT INTO source_parse_contexts
    (parse_operation_id,dependency_count,maximum_context_bytes)
    SELECT ?,?,? WHERE NOT EXISTS(SELECT 1 FROM source_parse_contexts WHERE parse_operation_id=?)
    ON CONFLICT DO NOTHING`,
    )
    .bind(operation, count, maximumBytes, operation);
}
