import { applyD1Migrations, type D1Migration, env } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import {
  acquireAdministrationClaimStatement,
  administrationOutcomeStatement,
  completeAdministrationStatement,
} from "../../../src/catalogue/ingestion/administration-idempotency-repository";
import {
  approveNoChangeRunStatement,
  publishReconciledPrintingImagesStatement,
  publishRevisionPrintingImagesStatement,
  recordNoChangeResultStatement,
  registerCatalogueRevisionStatement,
} from "../../../src/catalogue/ingestion/publication-commit-repository";
import {
  completeFixtureRunStatement,
  transitionRunStatement,
} from "../../../src/catalogue/ingestion/run-lifecycle-repository";
import { atomicRepositoryStatement, catalogueStore, runTransitionGuardStatement } from "../../../src/catalogue/shared";
import {
  coreGuardPublicationTime,
  coreGuardRun,
  coreRevisionImageCount,
  markCoreGuardSibling,
  removeAdministrationGuards,
  removeCoreRunGuards,
  removePublicationGuards,
  retainCoreTermination,
  seedCoreGuardRun,
  terminateCoreRunWithFailureCode,
} from "./query-helpers/core-guards";
import { seedSearchMaterializationRevision } from "./query-helpers/search-materialization";

const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };
beforeEach(async () => {
  await applyD1Migrations(testEnv.CATALOGUE_DB, testEnv.TEST_MIGRATIONS);
  await removeCoreRunGuards(testEnv.CATALOGUE_DB);
});
test("an unreserved run cannot advance and rolls back its sibling write without schema guards", async () => {
  const database = catalogueStore(testEnv.CATALOGUE_DB);
  await seedCoreGuardRun(testEnv.CATALOGUE_DB, "run_unreserved", "planning", false);
  const before = await coreGuardPublicationTime(database).first();
  await expect(
    database.batch([
      markCoreGuardSibling(database),
      transitionRunStatement(database, {
        runId: "run_unreserved",
        from: "planning",
        to: "collecting",
        progressJson: "{}",
      }),
    ]),
  ).rejects.toThrow("run_not_active");
  expect(await coreGuardRun(database, "run_unreserved").first("state")).toBe("planning");
  expect(await coreGuardPublicationTime(database).first()).toEqual(before);
});

test("a stale administration owner cannot complete or commit sibling mutations without schema guards", async () => {
  await removeAdministrationGuards(testEnv.CATALOGUE_DB);
  const database = catalogueStore(testEnv.CATALOGUE_DB);
  const key = "stale_administration_owner";
  await acquireAdministrationClaimStatement(database, {
    key,
    operation: "reject_run",
    requestJson: "{}",
    claimedAt: "2026-09-01T00:00:00.000Z",
    ownerToken: "current",
    expiresAt: "2026-09-02T00:00:00.000Z",
  }).run();
  const before = await coreGuardPublicationTime(database).first();
  await expect(
    database.batch([
      markCoreGuardSibling(database),
      completeAdministrationStatement(database, {
        key,
        operation: "reject_run",
        requestJson: "{}",
        responseJson: "{}",
        status: 200,
        createdAt: "2026-09-01T00:00:00.000Z",
        ownerToken: "stale",
        claimVersion: 1,
      }),
    ]),
  ).rejects.toThrow("administration_idempotency_owner_changed");
  expect(await administrationOutcomeStatement(database, key).first()).toBeNull();
  expect(await coreGuardPublicationTime(database).first()).toEqual(before);
});

test("candidate finalization requires its exact seven-day deadline without schema guards", async () => {
  const database = catalogueStore(testEnv.CATALOGUE_DB);
  await seedCoreGuardRun(testEnv.CATALOGUE_DB, "run_bad_deadline", "reconciling");
  await expect(
    completeFixtureRunStatement(database, {
      runId: "run_bad_deadline",
      candidateDigest: "candidate",
      candidateCreatedAt: "2026-09-01T00:00:00.000Z",
      approvalDeadline: "2026-09-09T00:00:00.000Z",
      progressJson: "{}",
    }).run(),
  ).rejects.toThrow("invalid_candidate_deadline");
  expect(await coreGuardRun(database, "run_bad_deadline").first("state")).toBe("reconciling");
});

test("an approval with absent digest fields fails closed without schema guards", async () => {
  const database = catalogueStore(testEnv.CATALOGUE_DB);
  await seedCoreGuardRun(testEnv.CATALOGUE_DB, "run_bad_approval", "awaiting_approval");
  await expect(
    approveNoChangeRunStatement(database, {
      runId: "run_bad_approval",
      approvalJson: "{}",
      idempotencyKey: "bad_approval",
      approvalHistoryJson: "[]",
      progressJson: "{}",
    }).run(),
  ).rejects.toThrow("approval_guard_failed");
  expect(await coreGuardRun(database, "run_bad_approval").first("state")).toBe("awaiting_approval");
});

test("a retained termination still requires the exact non-NULL failure code after the schema guard is removed", async () => {
  const database = catalogueStore(testEnv.CATALOGUE_DB);
  await seedCoreGuardRun(testEnv.CATALOGUE_DB, "run_null_termination", "paused");
  await retainCoreTermination(testEnv.CATALOGUE_DB, "run_null_termination");
  const terminate = (failureCode: string | null) =>
    atomicRepositoryStatement(database, {
      statement: terminateCoreRunWithFailureCode(database, "run_null_termination", failureCode),
      after: [runTransitionGuardStatement(database, { runId: "run_null_termination", from: "paused", to: "failed" })],
    });
  await expect(terminate(null).run()).rejects.toThrow("illegal_ingestion_transition");
  expect(await coreGuardRun(database, "run_null_termination").first("state")).toBe("paused");
  await terminate("ingestion_run_terminated").run();
  expect(await coreGuardRun(database, "run_null_termination").first()).toMatchObject({
    state: "failed",
    failure_code: "ingestion_run_terminated",
  });
});

test("a stale transition compare-and-set retains its no-op result without changing a later-state run", async () => {
  const database = catalogueStore(testEnv.CATALOGUE_DB);
  await seedCoreGuardRun(testEnv.CATALOGUE_DB, "run_replayed_transition", "parsing");
  const result = await transitionRunStatement(database, {
    runId: "run_replayed_transition",
    from: "planning",
    to: "collecting",
    progressJson: "{}",
  }).run();
  expect(result.meta.changes).toBe(0);
  expect(await coreGuardRun(database, "run_replayed_transition").first("state")).toBe("parsing");
});

test("a cleanup completion without matching completed cleanup evidence cannot persist", async () => {
  await removeAdministrationGuards(testEnv.CATALOGUE_DB);
  const database = catalogueStore(testEnv.CATALOGUE_DB);
  await expect(
    completeAdministrationStatement(database, {
      key: "missing_cleanup",
      operation: "retry_publication_cleanup",
      requestJson: '{"run_id":"missing"}',
      responseJson: "{}",
      status: 200,
      createdAt: "2026-09-01T00:00:00.000Z",
      ownerToken: null,
      claimVersion: null,
    }).run(),
  ).rejects.toThrow("cleanup_completion_claim_changed");
  expect(await administrationOutcomeStatement(database, "missing_cleanup").first()).toBeNull();
});

test("publication cannot register a revision without matching approval evidence after schema guards are removed", async () => {
  await removePublicationGuards(testEnv.CATALOGUE_DB);
  const database = catalogueStore(testEnv.CATALOGUE_DB);
  await seedCoreGuardRun(testEnv.CATALOGUE_DB, "run_bad_publication", "publishing");
  const before = await coreGuardPublicationTime(database).first();
  await expect(
    database.batch([
      markCoreGuardSibling(database),
      registerCatalogueRevisionStatement(database, {
        revisionId: "catrev_bad_publication",
        runId: "run_bad_publication",
        publishedAt: "2026-09-01T00:00:00.000Z",
        contentDigest: "catalogue",
        expectedRevisionId: "catrev_spine_000",
        candidateDigest: "candidate",
      }),
    ]),
  ).rejects.toThrow("publication_guard_failed");
  expect(await coreGuardPublicationTime(database).first()).toEqual(before);
});

test("no-change results require the candidate's exact catalogue digest after schema guards are removed", async () => {
  await removePublicationGuards(testEnv.CATALOGUE_DB);
  const database = catalogueStore(testEnv.CATALOGUE_DB);
  await seedCoreGuardRun(testEnv.CATALOGUE_DB, "run_bad_no_change", "awaiting_approval");
  await expect(
    recordNoChangeResultStatement(database, {
      runId: "run_bad_no_change",
      revisionId: "catrev_spine_000",
      candidateDigest: "candidate",
      checkedAt: "2026-09-01T00:00:00.000Z",
    }).run(),
  ).rejects.toThrow("no_change_guard_failed");
});

test("an already completed administration action cannot acquire another claim without schema guards", async () => {
  await removeAdministrationGuards(testEnv.CATALOGUE_DB);
  const database = catalogueStore(testEnv.CATALOGUE_DB);
  await completeAdministrationStatement(database, {
    key: "completed_action",
    operation: "reject_run",
    requestJson: "{}",
    responseJson: "{}",
    status: 200,
    createdAt: "2026-09-01T00:00:00.000Z",
    ownerToken: null,
    claimVersion: null,
  }).run();
  await expect(
    acquireAdministrationClaimStatement(database, {
      key: "completed_action",
      operation: "reject_run",
      requestJson: "{}",
      claimedAt: "2026-09-01T00:00:00.000Z",
      ownerToken: "late",
      expiresAt: "2026-09-02T00:00:00.000Z",
    }).run(),
  ).rejects.toThrow("administration_idempotency_completed");
});

test("one image with missing projected content rejects the entire multi-image publication", async () => {
  await removePublicationGuards(testEnv.CATALOGUE_DB);
  const database = catalogueStore(testEnv.CATALOGUE_DB);
  // This fixture creates a real approved revision with no published image rows.
  await seedCoreGuardRun(testEnv.CATALOGUE_DB, "run_image_fixture_reset", "planning", false);
  await seedSearchMaterializationRevision(testEnv.CATALOGUE_DB);
  const images = ["image_valid", "image_invalid"].map((id) => ({
    id,
    printing_id: id,
    role: "front",
    media_type: "image/webp",
    width: 1,
    height: 1,
    content_sha256: "a".repeat(64),
    content_byte_length: 1,
    object_key: `printing-images/${id}`,
  }));
  await publishReconciledPrintingImagesStatement(database, JSON.stringify(images)).run();
  await expect(
    publishRevisionPrintingImagesStatement(database, {
      revisionId: "catrev_materialization",
      imagesJson: JSON.stringify(
        images.map((image, index) => ({
          image_id: image.id,
          printing_id: image.printing_id,
          media_type: index === 0 ? image.media_type : null,
          content_sha256: image.content_sha256,
          content_byte_length: image.content_byte_length,
          object_key: image.object_key,
        })),
      ),
    }).run(),
  ).rejects.toThrow("revision_printing_image_content_missing");
  expect(await coreRevisionImageCount(database, "catrev_materialization").first("count")).toBe(0);
});
