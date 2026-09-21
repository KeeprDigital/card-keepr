/** Represent a run created before migration 0042. Preserve its complete source
 * graph and receipts while removing only accounting that did not exist then. */
export function acquisitionLegacyFixtureStatements(db: D1Database, runId: string) {
  const tables = [
    ["ingestion_acquisition_pauses", "acquisition_pause_not_deleted", "acquisition_pause_immutable"],
    ["source_dispatch_reservations", "source_dispatch_not_deleted", "source_dispatch_immutable"],
    ["ingestion_acquisition_policies", "acquisition_policy_not_deleted", "acquisition_policy_immutable"],
    ["ingestion_acquisition_accounts", "acquisition_account_not_deleted", "acquisition_coverage_immutable"],
  ];
  return tables.flatMap(([table, trigger, diagnostic]) => [
    db.prepare(`DROP TRIGGER ${trigger}`),
    db.prepare(`DELETE FROM ${table} WHERE ingestion_run_id=?`).bind(runId),
    db.prepare(`CREATE TRIGGER ${trigger} BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'${diagnostic}'); END`),
  ]);
}
