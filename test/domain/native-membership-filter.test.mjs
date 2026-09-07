import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import { catalogueStore } from "../../src/catalogue/shared/catalogue-store-repository.ts";
import {
  composedCollectionStatement,
  composedRelationsStatement,
  publicationExportDependenciesStatement,
} from "../../src/catalogue/read/composition-read-repository.ts";
import { d1Adapter } from "../../acceptance/helpers/query-helpers/sqlite-d1-adapter.mjs";
import { seedNativeMemberships } from "./query-helpers/native-memberships.mjs";

test("native Card and Printing filters use current Product membership within the pinned composition", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const name of (await readdir("migrations")).filter((n) => n.endsWith(".sql")).sort())
      db.exec(await readFile(`migrations/${name}`, "utf8"));
    seedNativeMemberships(db);
    const store = catalogueStore(d1Adapter(db));
    const selected = await composedRelationsStatement(
      store,
      "revision",
      "product_relationships",
      "from.id",
      "printing",
      "",
    ).all();
    const budgeted = await publicationExportDependenciesStatement(store, "candidate", "printing").all();
    assert.deepEqual(
      selected.results.map((row) => row.entity_id),
      ["current"],
    );
    assert.deepEqual(
      selected.results.map((row) => row.entity_id),
      budgeted.results.map((row) => row.entity_id),
    );
    for (const kind of ["cards", "printings"])
      for (const [filter, value, expected] of [
        ["product_id", "product_old", 0],
        ["release_region", "EN-US", 0],
        ["product_id", "product_current", 1],
        ["release_region", "EN-OCEANIA", 1],
      ]) {
        const filters = {
          game: null,
          q: null,
          card_id: null,
          card_number: null,
          rarity: null,
          product_id: null,
          release_region: null,
          [filter]: value,
        };
        const { results } = await composedCollectionStatement(store, "revision", kind, "", 10, filters).all();
        assert.equal(results.length, expected, `${kind} ${filter}=${value}`);
      }
  } finally {
    db.close();
  }
});
