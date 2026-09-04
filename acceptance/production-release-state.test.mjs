import assert from "node:assert/strict";
import {
  releaseStateDatabase,
  leaseStateDatabase,
  changedReleaseRows,
  releaseState,
  leaseState,
} from "./helpers/query-helpers/production-release-state.mjs";
import test from "node:test";
import {
  productionReleaseTransitionSql,
  productionReleaseLeaseAssignmentsSql,
} from "../scripts/production-release-state.mjs";

const states = ["requested", "preflight", "migrating", "deploying", "smoke_testing", "succeeded", "failed"];
const allowed = new Set([
  "requested:preflight",
  "requested:failed",
  "preflight:migrating",
  "preflight:failed",
  "migrating:deploying",
  "migrating:failed",
  "deploying:smoke_testing",
  "deploying:failed",
  "smoke_testing:succeeded",
  "smoke_testing:failed",
]);
const facts = { apiVersionId: "api", ingestionVersionId: "ingestion", evidenceJson: "{}", rollForwardRequired: true };

test("compiled Production Release transitions enforce every state edge without triggers", () => {
  for (const from of states)
    for (const to of states) {
      const database = releaseStateDatabase(from);
      try {
        if (to === "requested") {
          assert.throws(
            () => productionReleaseTransitionSql("release_matrix", to, facts),
            /illegal production release transition/,
          );
          assert.equal(releaseState(database).get().state, from);
          continue;
        }
        database.exec(productionReleaseTransitionSql("release_matrix", to, facts));
        const permitted = allowed.has(`${from}:${to}`);
        assert.equal(changedReleaseRows(database).get().changes, permitted ? 1 : 0, `${from} -> ${to}`);
        assert.equal(releaseState(database).get().state, permitted ? to : from);
      } finally {
        database.close();
      }
    }
});

test("a failed phase after migration refuses rollback without schema triggers", () => {
  for (const state of ["migrating", "deploying", "smoke_testing"]) {
    const database = releaseStateDatabase(state);
    try {
      assert.throws(
        () =>
          database.exec(
            productionReleaseTransitionSql("release_matrix", "failed", {
              rollForwardRequired: false,
            }),
          ),
        /roll_forward_required/,
        state,
      );
      assert.equal(releaseState(database).get().state, state);
      database.exec(productionReleaseTransitionSql("release_matrix", "failed", { rollForwardRequired: true }));
      assert.equal(releaseState(database).get().roll_forward_required, 1);
    } finally {
      database.close();
    }
  }
});

test("compiled lease writers reject incomplete or malformed canonical pairs atomically without triggers", () => {
  const database = leaseStateDatabase();
  try {
    for (const [id, expiry] of [
      ["release", null],
      [null, "2026-09-04T00:00:00.000Z"],
      ["release", "bad-date"],
    ]) {
      assert.throws(
        () =>
          database.exec(
            `UPDATE operation_state SET ${productionReleaseLeaseAssignmentsSql(id, expiry)} WHERE singleton=1`,
          ),
        /production_release_lease_invalid/,
      );
      assert.equal(leaseState(database).get().active_production_release_id, null);
    }
    database.exec(
      `UPDATE operation_state SET ${productionReleaseLeaseAssignmentsSql("release", "2026-09-04T00:00:00.000Z")} WHERE singleton=1`,
    );
    assert.equal(leaseState(database).get().active_production_release_id, "release");
    database.exec(`UPDATE operation_state SET ${productionReleaseLeaseAssignmentsSql(null, null)} WHERE singleton=1`);
    assert.equal(leaseState(database).get().active_production_release_id, null);
  } finally {
    database.close();
  }
});
