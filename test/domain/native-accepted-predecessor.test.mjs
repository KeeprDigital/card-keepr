import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import { catalogueStore } from "../../src/catalogue/shared/catalogue-store-repository.ts";
import { nativePredecessorGameCandidateStatement } from "../../src/catalogue/reconciliation/game-candidate-repository.ts";
import { d1Adapter } from "../../acceptance/helpers/query-helpers/sqlite-d1-adapter.mjs";
import { seedPinnedNativeEvidence } from "./query-helpers/native-accepted-predecessor.mjs";

test("native continuations retain their accepted evidence predecessor while consumer composition is unchanged", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    seedPinnedNativeEvidence(db);
    const store = catalogueStore(d1Adapter(db));
    const prior = (preparation) =>
      nativePredecessorGameCandidateStatement(store, "revision", "one-piece", preparation).first();
    assert.equal((await prior("proposed")).id, "accepted");
    assert.equal((await prior("later")).id, "proposed");
    assert.equal(
      (await prior("proposed")).id,
      "accepted",
      "later acceptance does not move an existing preparation pin",
    );
    assert.equal((await prior(null)).id, "public", "historical composition inspection stays immutable");
    assert.equal(
      (await prior("historical-run")).id,
      "public",
      "legacy reconciliation retains its composition fallback",
    );
  } finally {
    db.close();
  }
});

test.each([
  ["missing preparation", "missing", "revision", "one-piece"],
  ["missing pin", "accepted", "revision", "one-piece"],
  ["different game", "proposed", "revision", "digimon"],
  ["different revision", "proposed", "different", "one-piece"],
])("native predecessor rejects %s", async (_label, preparation, revision, game) => {
  const db = new DatabaseSync(":memory:");
  try {
    seedPinnedNativeEvidence(db);
    await assert.rejects(
      () => nativePredecessorGameCandidateStatement(catalogueStore(d1Adapter(db)), revision, game, preparation).first(),
      /accepted_predecessor_pin_missing/u,
    );
  } finally {
    db.close();
  }
});
