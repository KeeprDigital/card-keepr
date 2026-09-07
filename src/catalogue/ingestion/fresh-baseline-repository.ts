import { type CatalogueStore, repositoryStatements } from "../shared";

export function freshBaselineHandoffStatement(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(database).prepare(`SELECT release_id,role,phase,dispatch_digest,request_json,evidence_json
    FROM fresh_baseline_handoffs`);
}

export function freshBaselineAvailableStatement(database: CatalogueStore): D1PreparedStatement {
  return repositoryStatements(database).prepare(`SELECT CASE WHEN
    NOT EXISTS(SELECT 1 FROM fresh_baseline_mutation_fence)
    AND EXISTS(SELECT 1 FROM fresh_baseline_quiescence WHERE ready=1)
    THEN 1 ELSE json_extract('{}','fresh_baseline_not_quiescent') END`);
}
