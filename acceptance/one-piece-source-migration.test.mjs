import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  seedMigrationRun,
  seedMigrationRevision,
  seedMigrationCard,
  migrationRevisions,
  migrationCards,
  migrationAdapters,
  migrationLevel,
  migrationForeignKeys,
} from "./helpers/query-helpers/one-piece-migration.mjs";

test("schema 24 to 25 registers Limitless without rewriting populated catalogue history", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    const names = (await readdir(new URL("../migrations/", import.meta.url)))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    for (const name of names.filter((name) => Number.parseInt(name, 10) < 25))
      database.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    assert.equal(migrationLevel(database).get().migration_level, 24);
    for (let index = 0; index < 3; index++) {
      const predecessor = index ? `migration_revision_${index - 1}` : "catrev_spine_000";
      seedMigrationRun(database).run(
        `migration_run_${index}`,
        "2026-09-08T00:00:00.000Z",
        predecessor,
        `migration_run_${index}`,
      );
      seedMigrationRevision(database).run(
        `migration_revision_${index}`,
        `migration_run_${index}`,
        "2026-09-08T00:00:00.000Z",
        "a".repeat(64),
        predecessor,
        "b".repeat(64),
      );
      seedMigrationCard(database).run(
        `migration_revision_${index}`,
        `card_${index}`,
        JSON.stringify({
          id: `card_${index}`,
          game: "one-piece",
          official_identity: { kind: "card_number", value: "P-001" },
        }),
      );
    }
    const revisions = migrationRevisions(database).all();
    const cards = migrationCards(database).all();
    const adapters = migrationAdapters(database).all();
    database.exec("BEGIN");
    database.exec(await readFile(new URL("../migrations/0025_one_piece_limitless.sql", import.meta.url), "utf8"));
    database.exec("COMMIT");
    assert.equal(migrationLevel(database).get().migration_level, 25);
    assert.deepEqual(migrationRevisions(database).all(), revisions);
    assert.deepEqual(migrationCards(database).all(), cards);
    const installed = migrationAdapters(database).all();
    assert.deepEqual(
      installed.filter((row) => row.adapter_version !== "limitless-one-piece-en@1"),
      adapters,
    );
    assert.deepEqual(
      { ...installed.find((row) => row.adapter_version === "limitless-one-piece-en@1") },
      {
        adapter_version: "limitless-one-piece-en@1",
        source_lineage: "limitless-one-piece-en",
        supported_game: "one-piece",
        game_profile_version: "one-piece@1",
        parser_contract: "limitless-one-piece-p001-html@1",
        adapter_origin: "production",
        request_capacity: 100,
      },
    );
    assert.deepEqual(migrationForeignKeys(database).all(), []);
  } finally {
    database.close();
  }
});
