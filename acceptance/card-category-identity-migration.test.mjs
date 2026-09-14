import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import * as queries from "./helpers/query-helpers/card-model-migration.mjs";

test("category migration preserves legacy token identities, dependent Printings and mutation fences", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA foreign_keys=ON");
    const root = new URL("../migrations/", import.meta.url);
    for (const name of (await readdir(root))
      .filter((name) => name.endsWith(".sql") && Number.parseInt(name, 10) < 33)
      .sort()) {
      database.exec("BEGIN");
      database.exec(await readFile(new URL(name, root), "utf8"));
      database.exec("COMMIT");
    }
    const [run, revision] = queries.seedLegacyRevision(database);
    run.run();
    revision.run("a".repeat(64), "b".repeat(64));
    for (const game of ["gundam", "riftbound"])
      for (const category of ["gameplay", "token"]) {
        const id = `${game}-${category}`;
        const card = {
          id,
          game,
          official_identity: { kind: "card_number", value: id },
          game_data: {
            profile: `${game}@1`,
            attributes:
              game === "gundam"
                ? { card_type: category === "token" ? "unit_token" : "unit" }
                : { supertypes: category === "token" ? ["token"] : [] },
          },
        };
        queries.seedLegacyCard(database).run(id, game, id);
        queries.seedLegacyPrinting(database).run(`printing-${id}`, id);
        queries.seedLegacyDocument(database).run(id, JSON.stringify({ data: card }));
        queries.seedLegacyQuery(database).run(id, JSON.stringify(card));
      }
    const cards = queries.legacyCards(database).all(),
      printings = queries.legacyPrintings(database).all();
    const history = queries
      .immutableHistoryStatements(database)
      .map(({ table, statement }) => ({ table, rows: statement.all() }));
    database.exec("BEGIN");
    database.exec(await readFile(new URL("0033_card_categories.sql", root), "utf8"));
    database.exec("COMMIT");
    assert.deepEqual(
      queries
        .legacyCards(database)
        .all()
        .map(({ category, ...card }) => card),
      cards.map((card) => ({ ...card })),
    );
    assert.deepEqual(queries.legacyPrintings(database).all(), printings);
    assert.deepEqual(
      queries.immutableHistoryStatements(database).map(({ table, statement }) => ({ table, rows: statement.all() })),
      history,
    );
    assert.deepEqual(
      queries
        .legacyCategories(database)
        .all()
        .map(({ card_id, category }) => [card_id, category]),
      [
        ["gundam-gameplay", "gameplay"],
        ["gundam-token", "token"],
        ["riftbound-gameplay", "gameplay"],
        ["riftbound-token", "token"],
      ],
    );
    assert.deepEqual(
      queries
        .legacyCards(database)
        .all()
        .map(({ id, category }) => [id, category]),
      queries
        .legacyCategories(database)
        .all()
        .map(({ card_id, category }) => [card_id, category]),
    );
    queries.newArtCard(database).run("gundam-art");
    assert.throws(() => queries.newArtCard(database).run("duplicate-art"), /UNIQUE/u);
    assert.throws(() => queries.changeCategory(database).run(), /reconciled_card_identity_immutable/u);
    queries.recoveryFence(database).run("blocked");
    assert.throws(() => queries.newArtCard(database).run("fenced-art"), /catalogue_recovery_writer_fenced/u);
    queries.recoveryFence(database).run("clear");
    assert.deepEqual(queries.foreignKeys(database).all(), []);
  } finally {
    database.close();
  }
});
