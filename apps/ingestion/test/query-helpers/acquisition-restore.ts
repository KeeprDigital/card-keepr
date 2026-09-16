/** Exact retained acquisition/source history queried in the independent SQL import. */
export function acquisitionRestoreQueries(runId: string) {
  return [
    "ingestion_acquisition_accounts",
    "ingestion_acquisition_policies",
    "source_dispatch_reservations",
    "ingestion_acquisition_pauses",
    "source_requests",
    "source_capture_operations",
    "source_snapshots",
    "source_fetch_attempts",
  ].map((table) => ({ table, sql: `SELECT * FROM ${table} WHERE ingestion_run_id=? ORDER BY rowid`, params: [runId] }));
}

/** Deliberately corrupt only the disposable copy, restoring its export fence. */
export function resetRestoredAcquisitionDispatchCount(runId: string) {
  return [
    { sql: "UPDATE operation_state SET recovery_restore_guard='clear' WHERE singleton=1", params: [] },
    { sql: "UPDATE ingestion_acquisition_accounts SET charged_dispatches=0 WHERE ingestion_run_id=?", params: [runId] },
    { sql: "UPDATE operation_state SET recovery_restore_guard='blocked' WHERE singleton=1", params: [] },
  ];
}
