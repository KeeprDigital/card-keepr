export function productionGraphCounts(db: D1Database) {
  return db.prepare(`SELECT COUNT(*) AS planned,
    SUM(source_snapshot_id IS NOT NULL) AS captured,
    SUM(state='pending') AS pending,SUM(state='failed') AS failed
    FROM source_requests WHERE ingestion_run_id=?`);
}
export function productionGraphPauses(db: D1Database) {
  return db.prepare(`SELECT request_capacity,capacity_generation,used_capacity,
    overflow_request_count,required_capacity,parent_request_id
    FROM ingestion_run_capacity_pauses WHERE ingestion_run_id=? ORDER BY capacity_generation`);
}
