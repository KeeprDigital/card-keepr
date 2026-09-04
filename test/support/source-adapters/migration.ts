import { syntheticAdapterRegistrations } from "./index";

/** Test databases install the same adapter identities as their test Worker. */
export const syntheticSourceAdapterMigration = {
  name: "test_source_adapters",
  queries: [
    ...syntheticAdapterRegistrations.map(
      (adapter) => `INSERT INTO source_adapter_versions
      (adapter_version, source_lineage, supported_game, game_profile_version, parser_contract, adapter_origin, request_capacity)
      VALUES (${[adapter.adapterVersion, adapter.sourceLineage, adapter.supportedGame, adapter.gameProfileVersion, adapter.parserContract, adapter.origin].map(sqlText).join(", ")}, ${adapter.requestCapacity})`,
    ),
  ],
};

function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
