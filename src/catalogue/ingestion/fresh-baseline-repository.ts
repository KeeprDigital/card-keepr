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

export function freshBaselineCorrectionByKeyStatement(database: CatalogueStore, key: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare("SELECT request_json,response_json FROM fresh_baseline_corrections WHERE idempotency_key=?")
    .bind(key);
}
export function latestFreshBaselineCorrectionStatement(database: CatalogueStore, digest: string): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(
      "SELECT generation,correction_digest,request_json,state,evidence_json FROM fresh_baseline_corrections WHERE handoff_dispatch_digest=? ORDER BY generation DESC LIMIT 1",
    )
    .bind(digest);
}
export function recordFreshBaselineCorrectionStatement(
  database: CatalogueStore,
  input: Readonly<{ digest: string; requestJson: string; responseJson: string; createdAt: string }>,
): D1PreparedStatement {
  return repositoryStatements(database)
    .prepare(`INSERT INTO fresh_baseline_corrections(correction_digest,handoff_dispatch_digest,idempotency_key,generation,previous_correction_digest,request_json,response_json,state,evidence_json,created_at)
 SELECT ?,json_extract(?,'$.handoff_dispatch_digest'),json_extract(?,'$.idempotency_key'),json_extract(?,'$.generation'),json_extract(?,'$.previous_correction_digest'),?,?,0,'[]',CASE WHEN EXISTS(SELECT 1 FROM fresh_baseline_handoffs WHERE dispatch_digest=json_extract(?,'$.handoff_dispatch_digest') AND role=json_extract(?,'$.expected_role') AND phase=json_extract(?,'$.expected_phase') AND phase IN (4,5)) THEN ? ELSE json_extract('{}','fresh_baseline_correction_changed') END`)
    .bind(
      input.digest,
      input.requestJson,
      input.requestJson,
      input.requestJson,
      input.requestJson,
      input.requestJson,
      input.responseJson,
      input.requestJson,
      input.requestJson,
      input.requestJson,
      input.createdAt,
    );
}
