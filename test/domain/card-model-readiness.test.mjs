import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import { catalogueStore } from "../../src/catalogue/shared/catalogue-store-repository.ts";
import { currentCardModelStatement } from "../../src/catalogue/read/card-model-repository.ts";
import { d1Adapter } from "../../acceptance/helpers/query-helpers/sqlite-d1-adapter.mjs";
import * as queries from "../../acceptance/helpers/query-helpers/card-model-migration.mjs";

test.each(["cards", "printings"])(
  "legacy %s model readiness uses indexed invalid records and invalidates on insert",
  async (kind) => {
    const database = new DatabaseSync(":memory:");
    try {
      for (const name of (await readdir("migrations")).filter((name) => name.endsWith(".sql")).sort())
        database.exec(await readFile(`migrations/${name}`, "utf8"));
      const [run, revision] = queries.seedLegacyRevision(database);
      run.run();
      revision.run("a".repeat(64), "b".repeat(64));
      queries.selectLegacyRevision(database).run();
      for (const envelope of [false, true]) {
        const card = {
          id: `card-${envelope}`,
          category: "gameplay",
          gameplay_applicability: "applicable",
          related_cards: [],
        };
        const printing = { id: `printing-${envelope}`, gameplay_applicability: "applicable" };
        queries.seedLegacyDocument(database).run(card.id, JSON.stringify(envelope ? { data: card } : card));
        queries
          .seedLegacyPrintingDocument(database)
          .run(printing.id, JSON.stringify(envelope ? { data: printing } : printing));
      }
      const adapter = d1Adapter(database),
        original = adapter.prepare;
      let plan;
      adapter.prepare = (sql) => {
        plan = database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all();
        return original(sql);
      };
      const store = catalogueStore(adapter);
      assert.equal((await currentCardModelStatement(store).first()).model_ready, 1);
      for (const index of ["revision_cards_unready_model", "revision_printings_unready_model"])
        assert.ok(
          plan.some((row) => row.detail.includes(index)),
          JSON.stringify(plan),
        );
      const write =
        kind === "cards" ? queries.seedLegacyDocument(database) : queries.seedLegacyPrintingDocument(database);
      write.run("old-record", JSON.stringify({ id: "old-record" }));
      write.run("null-fields", JSON.stringify({ category: null, gameplay_applicability: null, related_cards: null }));
      assert.equal((await currentCardModelStatement(store).first()).model_ready, 0);
      assert.deepEqual(
        queries
          .legacyReadiness(database, kind)
          .all()
          .filter((row) => ["old-record", "null-fields"].includes(row.id))
          .map((row) => row.card_model_ready),
        [0, 0],
      );
    } finally {
      database.close();
    }
  },
);
