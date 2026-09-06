import { type CatalogueStore, repositoryStatements, canonicalJson } from "../shared";
import type { EvidencePlan } from "./source-evidence-model";

export function sourceCoverageCountsStatement(database: CatalogueStore, runId: string, plan: EvidencePlan) {
  return repositoryStatements(database)
    .prepare(`SELECT
    COUNT(*) AS planned_requests,
    SUM(CASE WHEN requests.state = 'observed' THEN 1 ELSE 0 END) AS observed_requests,
    MAX(snapshots.retrieved_at) AS last_capture_at,
    MIN((WITH RECURSIVE provenance(id, retrieved_at, reused_source_snapshot_id) AS (
      SELECT id, retrieved_at, reused_source_snapshot_id FROM source_snapshots WHERE id = snapshots.id
      UNION
      SELECT previous.id, previous.retrieved_at, previous.reused_source_snapshot_id
        FROM source_snapshots AS previous JOIN provenance ON previous.id = provenance.reused_source_snapshot_id
    ) SELECT MIN(retrieved_at) FROM provenance)) AS content_captured_at,
    SUM(CASE WHEN snapshots.reused_source_snapshot_id IS NOT NULL THEN 1 ELSE 0 END) AS revalidated_requests
    FROM source_requests AS requests
    LEFT JOIN source_snapshots AS snapshots ON snapshots.id = requests.source_snapshot_id
    WHERE requests.ingestion_run_id = ?1 AND requests.request_role <> 'image'
      AND (substr(requests.request_id, 1, length(?2) + 1) = ?2 || ':'
        OR requests.request_id IN (SELECT json_extract(value, '$.id') FROM json_each(?3)))`)
    .bind(runId, plan.source_lineage, canonicalJson(plan.requests));
}
