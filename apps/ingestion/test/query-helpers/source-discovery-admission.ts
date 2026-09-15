import { atomicRepositoryStatement, repositoryStatements, type CatalogueStore } from "../../../../src/catalogue/shared";
import { sourceRequestPlanGuardStatement } from "../../../../src/catalogue/source-evidence/source-plan-repository";

export type Padding = {
  id: string;
  url: string;
  headers_json: string;
  representation_fingerprint: string;
  sequence_number: number;
};
export function seedAdmissionPlans(db: CatalogueStore) {
  return repositoryStatements(db).prepare(`INSERT INTO source_discovery_request_plans
      (ingestion_run_id,request_id,sequence_number,parent_request_id,method,url,request_headers_json,representation_fingerprint,request_role)
      SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.sequence_number'),?,'GET',json_extract(value,'$.url'),
        json_extract(value,'$.headers_json'),json_extract(value,'$.representation_fingerprint'),'image' FROM json_each(?)`);
}
export function seedAdmissionRequests(db: CatalogueStore, runId: string, rowsJson: string, requestIdsJson: string) {
  return atomicRepositoryStatement(db, {
    statement: repositoryStatements(db)
      .prepare(
        `INSERT INTO source_requests
        (ingestion_run_id,request_id,sequence_number,method,url,request_headers_json,representation_fingerprint,state,request_role,discovered_from_request_id)
        SELECT ingestion_run_id,request_id,sequence_number,method,url,request_headers_json,representation_fingerprint,'pending',request_role,parent_request_id
        FROM source_discovery_request_plans WHERE ingestion_run_id=? AND request_id IN (SELECT json_extract(value,'$.id') FROM json_each(?))`,
      )
      .bind(runId, rowsJson),
    after: [sourceRequestPlanGuardStatement(db, runId, requestIdsJson)],
  });
}
export function populationFacts(db: CatalogueStore) {
  return repositoryStatements(db).prepare(`SELECT
    (SELECT COUNT(*) FROM source_requests WHERE ingestion_run_id=?1) AS requests,
    (SELECT COUNT(*) FROM source_discovery_request_plans WHERE ingestion_run_id=?1) AS plans,
    (SELECT COUNT(*) FROM source_requests WHERE ingestion_run_id=?1 AND request_role='image' AND state='pending') AS pending_images,
    (SELECT COUNT(*) FROM source_requests r JOIN source_discovery_request_plans p
      ON p.ingestion_run_id=r.ingestion_run_id AND p.request_id=r.request_id
      WHERE r.ingestion_run_id=?1 AND (r.sequence_number<>p.sequence_number OR r.method<>p.method OR r.url<>p.url
        OR r.request_headers_json<>p.request_headers_json OR r.representation_fingerprint<>p.representation_fingerprint
        OR r.request_role<>p.request_role OR r.discovered_from_request_id<>p.parent_request_id)) AS mismatches,
    (SELECT COUNT(*) FROM source_requests WHERE ingestion_run_id=?1 AND request_id NOT LIKE 'scryfall-magic-en:%') AS wrong_lineage,
    (SELECT COUNT(*) FROM source_discovery_request_plans WHERE ingestion_run_id=?1 AND request_role='image' AND parent_request_id<>?2) AS wrong_parent,
    (SELECT COUNT(*) FROM source_fetch_attempts WHERE ingestion_run_id=?1) AS fetch_attempts`);
}
export function proposalRows(db: CatalogueStore) {
  return repositoryStatements(db)
    .prepare(`SELECT r.*,p.sequence_number AS plan_sequence,p.parent_request_id AS plan_parent,
    p.method AS plan_method,p.url AS plan_url,p.request_headers_json AS plan_headers,p.representation_fingerprint AS plan_fingerprint,
    p.request_role AS plan_role FROM source_requests r LEFT JOIN source_discovery_request_plans p
    ON p.ingestion_run_id=r.ingestion_run_id AND p.request_id=r.request_id
    WHERE r.ingestion_run_id=? AND r.request_id IN (SELECT value FROM json_each(?)) ORDER BY r.request_id`);
}
export function reservation(db: CatalogueStore) {
  return repositoryStatements(db).prepare(
    "SELECT ingestion_run_id FROM ingestion_collection_reservations WHERE ingestion_run_id=?",
  );
}
export function groupedCount(db: CatalogueStore) {
  return repositoryStatements(db).prepare(
    "SELECT request_role,state,count(*) AS count FROM source_requests WHERE ingestion_run_id=? GROUP BY request_role,state ORDER BY request_role,state",
  );
}
export function failureRun(db: CatalogueStore) {
  return repositoryStatements(db).prepare(`SELECT c.state,p.collection_completed_at FROM ingestion_run_current c
    JOIN ingestion_evidence_plans p ON p.ingestion_run_id=c.ingestion_run_id WHERE c.ingestion_run_id=?`);
}

export function diagnosticRunExists(db: CatalogueStore) {
  return repositoryStatements(db).prepare("SELECT COUNT(*) AS count FROM ingestion_runs WHERE idempotency_key=?");
}
