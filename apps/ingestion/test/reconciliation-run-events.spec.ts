import { applyD1Migrations, env, type D1Migration } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import { catalogueStore, createRunEventStatement, foldRunEvents } from "../../../src/catalogue/shared";
import { transitionRunStatement } from "../../../src/catalogue/ingestion/run-lifecycle-repository";
import {
  beginReconciliationStatement,
  reviewableCandidateStatement,
  blockedCandidateStatement,
  failedReconciliationStatement,
  failedReconciliationWorkflowStatement,
} from "../../../src/catalogue/reconciliation/reconciliation-state-repository";
import {
  failInvalidCuratedCandidateStatement,
  failCuratedSourceChangeRunStatement,
} from "../../../src/catalogue/curated/curated-repository";
import { catalogueVerificationStatement } from "../../../src/catalogue/backup-recovery/backup-verification-repository";
import {
  reserveEventRun,
  corruptPublishedRunProjection,
  removeRetainedRunDiagnostics,
  readEventRun,
  readRunEvents,
  readRunEventPayloadCount,
} from "./query-helpers/reconciliation-run-events";
import {
  approveNoChangeRunStatement,
  registerCatalogueRevisionStatement,
  advanceCatalogueRevisionStatement,
  publishApprovedRunStatement,
} from "../../../src/catalogue/ingestion/publication-commit-repository";
const testEnv = env as Env & { TEST_MIGRATIONS: D1Migration[] };
const database = catalogueStore(testEnv.CATALOGUE_DB);
const observedAt = "2026-09-04T00:00:00.000Z";
beforeEach(async () => applyD1Migrations(testEnv.CATALOGUE_DB, testEnv.TEST_MIGRATIONS));

async function parsingRun(runId: string) {
  await database.batch([
    createRunEventStatement(database, {
      runId,
      selectedGamesJson: '["one-piece"]',
      startedAt: observedAt,
      linkedRunId: null,
      idempotencyKey: runId,
      state: "collecting",
    }),
    reserveEventRun(testEnv.CATALOGUE_DB, runId),
    transitionRunStatement(database, {
      runId,
      from: "collecting",
      to: "parsing",
      progressJson: '{"completed_stages":["planning","collecting"],"current_stage":"parsing"}',
    }),
  ]);
}
function candidate(runId: string) {
  return {
    runId,
    candidatePayload: '{"chunked_reconciliation_payload":"candidate"}',
    candidateDigest: "a".repeat(64),
    catalogueDigest: "b".repeat(64),
    createdAt: observedAt,
    approvalDeadline: "2026-09-11T00:00:00.000Z",
    warningsJson: '[{"code":"retained-warning"}]',
  };
}

test("reconciliation records ordered candidate events and payload references with replay remaining a no-op", async () => {
  const runId = "run_event_reconciliation";
  await parsingRun(runId);
  const statements = [
    beginReconciliationStatement(database, runId),
    reviewableCandidateStatement(database, candidate(runId)),
  ];
  await database.batch(statements);
  const before = await readRunEvents(testEnv.CATALOGUE_DB, runId).all();
  await database.batch(statements);
  expect((await readRunEvents(testEnv.CATALOGUE_DB, runId).all()).results).toEqual(before.results);
  expect(before.results.map((event) => event.event_kind)).toEqual([
    "created",
    "stage_changed",
    "stage_changed",
    "candidate_prepared",
  ]);
  expect(await readEventRun(testEnv.CATALOGUE_DB, runId).first()).toMatchObject({
    state: "awaiting_approval",
    candidate_json: candidate(runId).candidatePayload,
    warnings_json: candidate(runId).warningsJson,
  });
  expect(await foldRunEvents(database, runId)).toMatchObject({
    last_event_sequence: 4,
    state: "awaiting_approval",
    completed_stage_count: 4,
    candidate_payload_event_sequence: 4,
    diagnostics_event_sequence: 4,
  });
  expect(await readRunEventPayloadCount(testEnv.CATALOGUE_DB, runId).first("count")).toBe(2);
});

test("a rejected candidate deadline rolls back the preceding stage event and all payload chunks", async () => {
  const runId = "run_event_bad_deadline";
  await parsingRun(runId);
  await expect(
    database.batch([
      beginReconciliationStatement(database, runId),
      reviewableCandidateStatement(database, {
        ...candidate(runId),
        approvalDeadline: "2026-09-05T00:00:00.000Z",
      }),
    ]),
  ).rejects.toThrow("invalid_candidate_deadline");
  expect(await foldRunEvents(database, runId)).toMatchObject({ state: "parsing", last_event_sequence: 2 });
  expect(await readRunEventPayloadCount(testEnv.CATALOGUE_DB, runId).first("count")).toBe(0);
});

test.each(["blocked", "reconciliation", "workflow", "curated-invalid", "curated-changed"])(
  "%s failures retain a rebuildable terminal event",
  async (kind) => {
    const runId = `run_event_failure_${kind}`;
    await parsingRun(runId);
    await beginReconciliationStatement(database, runId).run();
    const input = {
      runId,
      terminalAt: observedAt,
      failureCode: "reconciliation_blocked",
      diagnosticsJson: '[{"code":"diagnostic"}]',
    };
    const statement =
      kind === "blocked"
        ? blockedCandidateStatement(database, { ...candidate(runId), ...input })
        : kind === "reconciliation"
          ? failedReconciliationStatement(database, input)
          : kind === "workflow"
            ? failedReconciliationWorkflowStatement(database, input)
            : kind === "curated-invalid"
              ? failInvalidCuratedCandidateStatement(database, { runId, observedAt })
              : failCuratedSourceChangeRunStatement(database, { runId, at: observedAt });
    await statement.run();
    await statement.run();
    const projected = await foldRunEvents(database, runId);
    expect(projected).toMatchObject({ state: "failed", last_event_sequence: 4, terminal_at: observedAt });
    expect((await readRunEvents(testEnv.CATALOGUE_DB, runId).all()).results.at(-1)?.event_kind).toBe(
      kind === "blocked" ? "candidate_blocked" : "failed",
    );
  },
);

test("backup verification executes the event and typed projection checks on real D1", async () => {
  expect(
    await catalogueVerificationStatement(database, {
      kind: "evidence",
      revisionId: "catrev_spine_000",
      expectedJson: "{}",
    }).first(),
  ).toMatchObject({ invalid_audit_rows: 0, audit_rows: 0 });
});

test.each(["scalar", "sequence", "selected-games", "missing-current", "payload-chunk"] as const)(
  "backup verification rejects a published run with damaged %s evidence",
  async (kind) => {
    const runId = `run_event_backup_${kind}`;
    const revisionId = `catrev_event_backup_${kind}`;
    await parsingRun(runId);
    const run = await readEventRun(testEnv.CATALOGUE_DB, runId).first<{ expected_current_revision_id: string }>();
    const expectedRevisionId = run!.expected_current_revision_id;
    await database.batch([
      beginReconciliationStatement(database, runId),
      reviewableCandidateStatement(database, candidate(runId)),
      approveNoChangeRunStatement(database, {
        runId,
        occurredAt: observedAt,
        idempotencyKey: `${runId}_approval`,
        approvalJson: JSON.stringify({
          action: "approved",
          approved_at: observedAt,
          candidate_digest: candidate(runId).candidateDigest,
          expected_current_revision_id: expectedRevisionId,
        }),
        progressJson: '{"completed_stages":["planning","collecting","parsing","reconciling","awaiting_approval"]}',
      }),
      registerCatalogueRevisionStatement(database, {
        revisionId,
        runId,
        publishedAt: observedAt,
        contentDigest: candidate(runId).catalogueDigest,
        expectedRevisionId,
        candidateDigest: candidate(runId).candidateDigest,
      }),
      advanceCatalogueRevisionStatement(database, { revisionId, publishedAt: observedAt, expectedRevisionId }),
      publishApprovedRunStatement(database, {
        revisionId,
        runId,
        manifestDigest: "c".repeat(64),
        completedAt: observedAt,
        progressJson:
          '{"completed_stages":["planning","collecting","parsing","reconciling","awaiting_approval","publishing"]}',
      }),
    ]);
    const verification = catalogueVerificationStatement(database, { kind: "evidence", revisionId, expectedJson: "{}" });
    expect(await verification.first()).toMatchObject({ invalid_audit_rows: 0, audit_rows: 1 });
    if (kind === "payload-chunk") await removeRetainedRunDiagnostics(testEnv.CATALOGUE_DB, runId);
    else await corruptPublishedRunProjection(testEnv.CATALOGUE_DB, runId, kind).run();
    expect(await verification.first()).toMatchObject({ invalid_audit_rows: 1, audit_rows: 1 });
  },
);
