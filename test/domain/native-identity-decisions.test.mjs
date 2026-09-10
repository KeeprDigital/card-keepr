import assert from "node:assert/strict";
import { test } from "vitest";
import { catalogueStore } from "../../src/catalogue/shared/catalogue-store-repository.ts";
import {
  identityDecisionStatement,
  insertIdentityDecisionStatement,
} from "../../src/catalogue/reconciliation/canonical-identity-repository.ts";
import { d1Adapter } from "../../acceptance/helpers/query-helpers/sqlite-d1-adapter.mjs";
import {
  decisionRows,
  identityDecision,
  identityDecisionDatabase,
  insertExplicitTarget,
  migrateIdentityDecisionTargets,
  seedHistoricalDecision,
  seedHistoricalPrinting,
  seedIdentityReview,
  seedNativeIdentityTarget,
  seedRepeatedIdentityReview,
} from "./query-helpers/native-identity-decisions.mjs";

test("decision migration preserves sparse historical rowids, replay fields and pinned cutoffs", async () => {
  const db = await identityDecisionDatabase();
  try {
    seedHistoricalPrinting(db, "historical-printing");
    for (const [id, rowid] of [
      ["earlier", 3],
      ["later", 17],
    ]) {
      seedIdentityReview(db, id, ["historical-printing"]);
      seedHistoricalDecision(db, rowid, id, "historical-printing");
    }
    db.exec(`INSERT INTO reconciliation_operations
      (id,ingestion_run_id,state,created_at,deadline,definition_pins_json,observation_cutoff,identity_decision_cutoff,authority_decision_cutoff)
      VALUES ('pinned','earlier-source','failed','2026-09-09','2026-09-09','{}',0,3,0)`);
    const before = decisionRows(db);
    const store = catalogueStore(d1Adapter(db));
    const earlier = await identityDecisionStatement(store, "earlier", "pinned").first();
    assert.equal(await identityDecisionStatement(store, "later", "pinned").first(), null);
    await migrateIdentityDecisionTargets(db);
    assert.deepEqual(decisionRows(db), before);
    assert.deepEqual(await identityDecisionStatement(store, "earlier", "pinned").first(), earlier);
    assert.equal(await identityDecisionStatement(store, "later", "pinned").first(), null);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.throws(() => db.exec("DELETE FROM reconciled_printings WHERE id='historical-printing'"), /FOREIGN KEY/u);
    assert.throws(
      () => db.exec("UPDATE canonical_identity_decisions SET rationale='changed'"),
      /canonical_identity_decision_immutable/u,
    );
    assert.throws(() => db.exec("DELETE FROM canonical_identity_decisions"), /canonical_identity_decision_immutable/u);
    assert.equal(db.prepare("SELECT migration_level FROM catalogue_schema_state").get().migration_level, 32);
  } finally {
    db.close();
  }
});

test("native owner decisions bind the review's published predecessor and preserve the public replay shape", async () => {
  const db = await identityDecisionDatabase();
  try {
    seedNativeIdentityTarget(db, "published", "printing");
    seedIdentityReview(db, "review", ["printing"], { predecessor: "published" });
    await migrateIdentityDecisionTargets(db);
    // A later head and lexically earlier repeated capture cannot redefine the
    // review's first retained predecessor before the owner decides.
    seedNativeIdentityTarget(db, "later", "printing");
    seedRepeatedIdentityReview(db, "review", "aaa-later-capture", "later");
    db.exec("INSERT INTO game_accepted_candidates VALUES ('one-piece','later')");
    const store = catalogueStore(d1Adapter(db));
    const decision = identityDecision("review", "printing");
    await insertIdentityDecisionStatement(store, decision).run();
    assert.deepEqual({ ...(await identityDecisionStatement(store, "review").first()) }, decision);
    assert.deepEqual(
      Object.keys(await identityDecisionStatement(store, "review").first()).sort(),
      Object.keys(decision).sort(),
    );
    assert.equal(
      db.prepare("SELECT native_candidate_id FROM canonical_identity_decisions").get().native_candidate_id,
      "published",
    );
    assert.deepEqual({ ...(await identityDecisionStatement(store, "review").first()) }, decision);
    assert.throws(
      () => db.exec("DELETE FROM publication_read_entities WHERE candidate_id='published'"),
      /FOREIGN KEY/u,
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
  }
});

test.each([
  ["missing Printing", {}],
  ["wrong kind", { kind: "cards" }],
  ["different game", { game: "gundam" }],
  ["unpublished target", { published: false }],
])("native decision rejects %s without creating a decision", async (label, targetOptions) => {
  const db = await identityDecisionDatabase();
  try {
    seedNativeIdentityTarget(db, "target", label === "missing Printing" ? "different" : "printing", targetOptions);
    seedIdentityReview(db, "review", ["printing"], { predecessor: "target" });
    // A legacy row with the same opaque ID cannot rescue an authoritative native miss.
    seedHistoricalPrinting(db, "printing");
    await migrateIdentityDecisionTargets(db);
    await assert.rejects(
      () =>
        insertIdentityDecisionStatement(catalogueStore(d1Adapter(db)), identityDecision("review", "printing")).run(),
      /identity_review_target_invalid|FOREIGN KEY/u,
    );
    assert.deepEqual(decisionRows(db), []);
  } finally {
    db.close();
  }
});

test("decision guards reject a missing pin, a different published predecessor and an unreviewed target", async () => {
  const db = await identityDecisionDatabase();
  try {
    seedNativeIdentityTarget(db, "published", "printing");
    seedNativeIdentityTarget(db, "different", "printing");
    seedHistoricalPrinting(db, "printing");
    seedIdentityReview(db, "missing-pin", ["printing"], { missingPin: true });
    seedIdentityReview(db, "wrong-predecessor", ["printing"], { predecessor: "published" });
    seedIdentityReview(db, "unreviewed", ["other"], { predecessor: "published" });
    await migrateIdentityDecisionTargets(db);
    assert.throws(() => insertExplicitTarget(db, "missing-pin", "printing", null), /identity_review_target_invalid/u);
    assert.throws(
      () => insertExplicitTarget(db, "wrong-predecessor", "printing", "different"),
      /identity_review_target_invalid/u,
    );
    assert.throws(
      () => insertExplicitTarget(db, "unreviewed", "printing", "published"),
      /identity_review_target_invalid/u,
    );
    assert.deepEqual(decisionRows(db), []);
  } finally {
    db.close();
  }
});

test("a reviewed legacy predecessor retains its historical Printing reference and operation-idle guard", async () => {
  const db = await identityDecisionDatabase();
  try {
    seedHistoricalPrinting(db, "printing");
    seedIdentityReview(db, "review", ["printing"], { predecessor: null });
    seedIdentityReview(db, "cross-game", ["printing"], { game: "gundam" });
    await migrateIdentityDecisionTargets(db);
    const store = catalogueStore(d1Adapter(db));
    const decision = identityDecision("review", "printing");
    db.exec("UPDATE operation_state SET active_ingestion_run_id='review-source'");
    await assert.rejects(
      () => insertIdentityDecisionStatement(store, decision).run(),
      /identity_decision_operation_not_idle/u,
    );
    assert.deepEqual(decisionRows(db), []);
    db.exec("UPDATE operation_state SET active_ingestion_run_id=NULL");
    await insertIdentityDecisionStatement(store, decision).run();
    assert.deepEqual({ ...(await identityDecisionStatement(store, "review").first()) }, decision);
    await assert.rejects(
      () => insertIdentityDecisionStatement(store, identityDecision("cross-game", "printing")).run(),
      /identity_review_target_invalid/u,
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
  }
});

test("recovery and handoff keep native decision writes fenced after the schema rebuild", async () => {
  const db = await identityDecisionDatabase();
  try {
    seedNativeIdentityTarget(db, "published", "printing");
    seedIdentityReview(db, "review", ["printing"], { predecessor: "published" });
    await migrateIdentityDecisionTargets(db);
    db.exec("UPDATE operation_state SET recovery_restore_guard='blocked'");
    assert.throws(
      () => insertExplicitTarget(db, "review", "printing", "published"),
      /catalogue_recovery_writer_fenced/u,
    );
    db.exec("UPDATE operation_state SET recovery_restore_guard='clear'");
    db.exec(`INSERT INTO administration_idempotency
      (idempotency_key,operation,request_json,response_json,http_status,outcome,created_at)
      VALUES ('fixture','prepare_production_release','{}','{"dispatch_digest":"fixture-digest","release_id":"fixture"}',200,'success','2026-09-09');
      UPDATE operation_state SET active_production_release_id='fixture';
      INSERT INTO fresh_baseline_handoffs VALUES
      ('fixture','source','fixture-digest','fixture-execution','{}','{"dispatch_digest":"fixture-digest","release_id":"fixture"}',1,'{}','2026-09-09')`);
    assert.throws(() => insertExplicitTarget(db, "review", "printing", "published"), /fresh_baseline_mutation_fenced/u);
    assert.deepEqual(decisionRows(db), []);
  } finally {
    db.close();
  }
});
