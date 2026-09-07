import { type CatalogueStore, repositoryStatements } from "../shared";

export function freshBaselineHandoffStatement(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(database).prepare(`SELECT release_id,role,phase,dispatch_digest,request_json,evidence_json
    FROM fresh_baseline_handoffs ORDER BY created_at DESC, release_id DESC LIMIT 1`);
}

export function freshBaselineAvailableStatement(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(database).prepare(`SELECT CASE WHEN
    NOT EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
    AND EXISTS(SELECT 1 FROM fresh_baseline_quiescence WHERE ready=1)
    THEN 1 ELSE json_extract('{}','fresh_baseline_not_quiescent') END`);
}

export function freshBaselineCancellationStatement(database: CatalogueStore, digest: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare("SELECT response_json FROM fresh_baseline_cancellations WHERE dispatch_digest=?")
    .bind(digest);
}
export function recordFreshBaselineCancellationStatement(
  database: CatalogueStore,
  digest: string,
  response: string,
  createdAt: string,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare("INSERT INTO fresh_baseline_cancellations(dispatch_digest,response_json,created_at) VALUES(?,?,?)")
    .bind(digest, response, createdAt);
}
