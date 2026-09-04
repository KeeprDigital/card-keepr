import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { catalogueStore } from "../../../src/catalogue/shared";
import {
  curatedLifecycleMutationStatements,
  curatedRevisionStatement,
  insertAuthoredCuratedRevisionStatement,
  insertCuratedRunPinSetStatement,
} from "../../../src/catalogue/curated/curated-repository";
import { coreGuardPublicationTime, markCoreGuardSibling } from "./query-helpers/core-guards";
import {
  removeCuratedGuards,
  occupyCuratedAdministration,
  clearCuratedAdministration,
  seedCuratedPinRun,
} from "./query-helpers/curated-guards";
const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };
beforeEach(async () => {
  await applyD1Migrations(testEnv.CATALOGUE_DB, testEnv.TEST_MIGRATIONS);
  await removeCuratedGuards(testEnv.CATALOGUE_DB);
  await clearCuratedAdministration(testEnv.CATALOGUE_DB);
});
const baseRevision = {
  revisionId: "curated_guard",
  game: "one-piece" as const,
  targetKey: "card:OP01-001:name",
  targetKind: "field" as const,
  effectiveFrom: null,
  effectiveTo: null,
  proposalJson: "{}",
  contentDigest: "a".repeat(64),
  reviewedSourceDigest: "b".repeat(64),
  schemaBindingJson: JSON.stringify({ catalogue_revision_id: "catrev_spine_000" }),
  observedAt: "2026-09-01T00:00:00.000Z",
};
test("stale Curated creation aborts its entire batch without schema guards", async () => {
  const database = catalogueStore(testEnv.CATALOGUE_DB);
  const revision = { ...baseRevision };
  const before = await coreGuardPublicationTime(database).first();
  await expect(
    database.batch([
      markCoreGuardSibling(database),
      insertAuthoredCuratedRevisionStatement(database, {
        ...revision,
        schemaBindingJson: '{"catalogue_revision_id":"stale"}',
      }),
    ]),
  ).rejects.toThrow("curated_revision_current_revision_mismatch");
  expect(await curatedRevisionStatement(database, revision.revisionId).first()).toBeNull();
  expect(await coreGuardPublicationTime(database).first()).toEqual(before);
});
test("an overlapping active target is rejected while disjoint dates remain valid without schema guards", async () => {
  const database = catalogueStore(testEnv.CATALOGUE_DB);
  const revision = { ...baseRevision, revisionId: "curated_overlap", targetKey: "overlap_target" };
  await insertAuthoredCuratedRevisionStatement(database, { ...revision, effectiveTo: "2026-10-01" }).run();
  await expect(
    insertAuthoredCuratedRevisionStatement(database, {
      ...revision,
      revisionId: "overlap",
      effectiveFrom: "2026-09-30",
    }).run(),
  ).rejects.toThrow("curated_revision_target_conflict");
  await insertAuthoredCuratedRevisionStatement(database, {
    ...revision,
    revisionId: "adjacent",
    effectiveFrom: "2026-10-01",
  }).run();
  expect(await curatedRevisionStatement(database, "adjacent").first()).not.toBeNull();
});
test("a stale owner event rolls back its preceding status mutation without schema guards", async () => {
  const database = catalogueStore(testEnv.CATALOGUE_DB);
  const revision = { ...baseRevision, revisionId: "curated_event", targetKey: "event_target" };
  await insertAuthoredCuratedRevisionStatement(database, revision).run();
  await expect(
    database.batch(
      curatedLifecycleMutationStatements(database, {
        revisionId: revision.revisionId,
        expectedEventVersion: 1,
        status: "retired",
        eventVersion: 2,
        kind: "retired",
        eventJson: '{"expected_current_revision_id":"stale"}',
        observedAt: revision.observedAt,
        idempotencyKey: "retire_stale",
        requestDigest: "c".repeat(64),
        responseJson: "{}",
      }),
    ),
  ).rejects.toThrow("curated_revision_current_revision_mismatch");
  expect(await curatedRevisionStatement(database, revision.revisionId).first("status")).toBe("active");
});

for (const kind of ["ingestion", "recovery", "release"] as const) {
  test(`Curated creation and owner events reject ${kind} occupancy without schema guards`, async () => {
    const database = catalogueStore(testEnv.CATALOGUE_DB);
    const revision = { ...baseRevision, revisionId: `curated_${kind}`, targetKey: `target_${kind}` };
    await insertAuthoredCuratedRevisionStatement(database, revision).run();
    await occupyCuratedAdministration(testEnv.CATALOGUE_DB, kind).run();
    const code = kind === "release" ? "curated_revision_release_not_idle" : "curated_revision_operation_not_idle";
    await expect(
      insertAuthoredCuratedRevisionStatement(database, {
        ...revision,
        revisionId: `blocked_${kind}`,
        targetKey: `blocked_${kind}`,
      }).run(),
    ).rejects.toThrow(code);
    await expect(
      database.batch(
        curatedLifecycleMutationStatements(database, {
          revisionId: revision.revisionId,
          expectedEventVersion: 1,
          status: "retired",
          eventVersion: 2,
          kind: "retired",
          eventJson: '{"expected_current_revision_id":"catrev_spine_000"}',
          observedAt: revision.observedAt,
          idempotencyKey: `retire_${kind}`,
          requestDigest: "c".repeat(64),
          responseJson: "{}",
        }),
      ),
    ).rejects.toThrow(code);
    expect(await curatedRevisionStatement(database, revision.revisionId).first("status")).toBe("active");
  });
}

test("the pinned set cannot omit an active Curated revision without schema guards", async () => {
  const database = catalogueStore(testEnv.CATALOGUE_DB);
  await insertAuthoredCuratedRevisionStatement(database, {
    ...baseRevision,
    revisionId: "curated_pin",
    targetKey: "pin_target",
  }).run();
  await seedCuratedPinRun(testEnv.CATALOGUE_DB, "run_pin_guard").run();
  await expect(
    insertCuratedRunPinSetStatement(database, {
      runId: "run_pin_guard",
      idsJson: "[]",
      setDigest: "c".repeat(64),
      observedAt: baseRevision.observedAt,
    }).run(),
  ).rejects.toThrow("curated_revision_pin_set_changed");
});
