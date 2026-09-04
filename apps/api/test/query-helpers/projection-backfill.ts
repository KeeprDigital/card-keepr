import type { D1Migration } from "cloudflare:test";

/** Exercise the checked-in one-time backfill against retained documents while
 * current run fixtures keep their event schema. Only the target projection is
 * removed; the temporary level change and backfill share one native transaction.
 */
export async function replayProjectionBackfill(
  database: D1Database,
  migrations: readonly D1Migration[],
  projection: "card-attributes" | "printings",
): Promise<void> {
  const name =
    projection === "card-attributes" ? "0008_card_attribute_projection.sql" : "0006_printing_query_projection.sql";
  const migration = migrations.find((entry) => entry.name === name);
  if (migration === undefined) throw new Error(`The checked-in backfill ${name} is missing.`);
  const currentLevel = await database
    .prepare("SELECT migration_level FROM catalogue_schema_state WHERE singleton = 1")
    .first<number>("migration_level");
  if (currentLevel === null) throw new Error("The current schema level is unavailable.");
  const removed =
    projection === "card-attributes"
      ? [database.prepare("DROP TABLE revision_card_attributes")]
      : [
          database.prepare("DROP TABLE revision_printing_product_query"),
          database.prepare("DROP TABLE revision_printing_query"),
        ];
  await database.batch([
    ...removed,
    database
      .prepare("UPDATE catalogue_schema_state SET migration_level = ? WHERE singleton = 1")
      .bind(projection === "card-attributes" ? 7 : 5),
    ...migration.queries.map((query) => database.prepare(query)),
    database.prepare("UPDATE catalogue_schema_state SET migration_level = ? WHERE singleton = 1").bind(currentLevel),
  ]);
}
