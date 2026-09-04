import type { DatabaseSync, StatementSync } from "node:sqlite";

// Dedicated test queries. Tests retain binding, execution, and atomic batch composition.

export function readSourceAdapterVersionsAdapterVersionSourceLineage(database: DatabaseSync): StatementSync {
  return database.prepare(`SELECT adapter_version, source_lineage, supported_game,
              game_profile_version, parser_contract, adapter_origin,
              request_capacity
       FROM source_adapter_versions
       ORDER BY adapter_version`);
}
