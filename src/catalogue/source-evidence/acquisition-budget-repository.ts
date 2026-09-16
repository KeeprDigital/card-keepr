import {
  atomicRepositoryStatement,
  type CatalogueStore,
  ingestionRunTransitionSql,
  repositoryStatements,
  runEventCommand,
  runEventIdentitySql,
  runEventStatement,
  runTransitionGuardStatement,
  runCurrentIntegrityGuardStatement,
} from "../shared";
import type { AcquisitionBudget, CollectionWorkflowAttempt } from "./source-evidence-model";
import { sourceParseAuthorityGuard } from "./source-parse-authority-repository";

export type AcquisitionAccount = AcquisitionBudget & {
  ingestion_run_id: string;
  run_state: string;
  generation: number;
  coverage_started_at: string;
  historical_dispatches_unknown: number;
  baseline_source_bytes: number;
  charged_dispatches: number;
  charged_source_bytes: number;
  reserved_source_bytes: number;
};
export type DispatchReservation = {
  id: string;
  ingestion_run_id: string;
  request_id: string;
  capture_operation_id: string;
  content_object_key: string;
  parent_workflow_id: string | null;
  workflow_instance_id: string | null;
  budget_generation: number;
  maximum_source_bytes: number;
  reserved_at: string;
  settled_at: string | null;
  charged_source_bytes: number | null;
};
export type AcquisitionDimension = "dispatches" | "source_bytes" | "deadline" | "policy_missing" | "ownership";
export type AcquisitionPause = {
  event_id: string;
  ingestion_run_id: string;
  generation: number | null;
  request_id: string;
  maximum_source_bytes: number;
  dimension: AcquisitionDimension;
  paused_at: string;
};

export function acquisitionAccount(db: CatalogueStore, runId: string) {
  return repositoryStatements(db)
    .prepare(
      `SELECT account.*,current.state AS run_state,policy.generation,policy.max_dispatches,
    policy.max_source_bytes,policy.dispatch_deadline FROM ingestion_acquisition_accounts account
    JOIN ingestion_acquisition_policies policy USING(ingestion_run_id)
    JOIN ingestion_run_current current USING(ingestion_run_id)
    WHERE account.ingestion_run_id=? ORDER BY policy.generation DESC LIMIT 1`,
    )
    .bind(runId);
}
export function acquisitionPolicyByKey(db: CatalogueStore, key: string) {
  return repositoryStatements(db)
    .prepare(`SELECT request_digest,response_json FROM ingestion_acquisition_policies WHERE idempotency_key=?`)
    .bind(key);
}
export function initialAcquisitionAccount(
  db: CatalogueStore,
  runId: string,
  at: string,
  historical: boolean,
  baseline: number,
) {
  return repositoryStatements(db)
    .prepare(
      `INSERT INTO ingestion_acquisition_accounts
    (ingestion_run_id,coverage_started_at,historical_dispatches_unknown,baseline_source_bytes,charged_source_bytes)
    VALUES (?,?,?,?,?)`,
    )
    .bind(runId, at, historical ? 1 : 0, baseline, baseline);
}
export function insertAcquisitionPolicy(
  db: CatalogueStore,
  input: {
    runId: string;
    generation: number;
    budget: AcquisitionBudget;
    at: string;
    key: string;
    digest: string;
    response: string;
  },
) {
  return repositoryStatements(db)
    .prepare(
      `INSERT INTO ingestion_acquisition_policies
    (ingestion_run_id,generation,max_dispatches,max_source_bytes,dispatch_deadline,created_at,idempotency_key,request_digest,response_json)
    VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      input.runId,
      input.generation,
      input.budget.max_dispatches,
      input.budget.max_source_bytes,
      input.budget.dispatch_deadline,
      input.at,
      input.key,
      input.digest,
      input.response,
    );
}
export function acquisitionExtensionGuard(db: CatalogueStore, runId: string, generation: number) {
  return repositoryStatements(db)
    .prepare(
      `SELECT CASE WHEN EXISTS(SELECT 1 FROM ingestion_run_read WHERE id=?1 AND state='paused')
    AND (SELECT MAX(generation) FROM ingestion_acquisition_policies WHERE ingestion_run_id=?1)=?2
    THEN 1 ELSE json_extract('{}','acquisition_extension_conflict') END`,
    )
    .bind(runId, generation);
}
export function acquisitionInitializationGuard(db: CatalogueStore, runId: string, eventId: string | null = null) {
  return repositoryStatements(db)
    .prepare(
      `SELECT CASE WHEN EXISTS(
    SELECT 1 FROM ingestion_run_current current JOIN ingestion_evidence_plans plan USING(ingestion_run_id)
    WHERE current.ingestion_run_id=?1 AND (?2 IS NULL OR current.last_event_id=?2)
      AND (current.state='paused' OR (current.state='collecting' AND plan.parent_workflow_id IS NULL
        AND NOT EXISTS(SELECT 1 FROM source_capture_operations WHERE ingestion_run_id=?1)
        AND NOT EXISTS(SELECT 1 FROM ingestion_workflow_attempts WHERE ingestion_run_id=?1)))
      AND plan.collection_completed_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM source_capture_operations WHERE ingestion_run_id=?1 AND state NOT IN ('uploaded','finalized'))
      AND NOT EXISTS(SELECT 1 FROM evidence_object_writers WHERE ingestion_run_id=?1 AND completed_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM ingestion_acquisition_accounts WHERE ingestion_run_id=?1)
  ) THEN 1 ELSE json_extract('{}','acquisition_initialization_not_quiescent') END`,
    )
    .bind(runId, eventId);
}
export function acquisitionLegacyEvent(db: CatalogueStore, runId: string) {
  return repositoryStatements(db)
    .prepare("SELECT last_event_id FROM ingestion_run_current WHERE ingestion_run_id=?")
    .bind(runId);
}
export function acquisitionLegacyWorkflows(db: CatalogueStore, runId: string, after: string) {
  return repositoryStatements(db)
    .prepare(
      `SELECT * FROM (
    SELECT workflow_instance_id AS id,workflow_kind AS kind FROM ingestion_workflow_attempts WHERE ingestion_run_id=?1
    UNION SELECT parent_workflow_id AS id,'parent' AS kind FROM ingestion_evidence_plans WHERE ingestion_run_id=?1 AND parent_workflow_id IS NOT NULL
  ) WHERE id>?2 ORDER BY id LIMIT 128`,
    )
    .bind(runId, after);
}
export function acquisitionLegacyRawKeys(db: CatalogueStore, runId: string, after: string) {
  return repositoryStatements(db)
    .prepare(
      `SELECT content_object_key AS object_key,
    MIN(content_digest) AS digest,MAX(content_digest) AS maximum_digest,
    MIN(content_byte_length) AS byte_length,MAX(content_byte_length) AS maximum_byte_length FROM (
      SELECT content_object_key,content_digest,content_byte_length FROM source_snapshots WHERE ingestion_run_id=?1
      UNION ALL SELECT content_object_key,content_digest,content_byte_length FROM source_capture_operations
        WHERE ingestion_run_id=?1 AND state IN ('uploaded','finalized') AND reused_source_snapshot_id IS NULL
    ) WHERE content_object_key>?2 GROUP BY content_object_key ORDER BY content_object_key LIMIT 128`,
    )
    .bind(runId, after);
}
export function acquisitionPause(db: CatalogueStore, runId: string) {
  return repositoryStatements(db)
    .prepare(
      `SELECT * FROM ingestion_acquisition_pauses WHERE ingestion_run_id=? ORDER BY paused_at DESC,event_id DESC LIMIT 1`,
    )
    .bind(runId);
}
export function unsettledDispatches(db: CatalogueStore, runId: string) {
  return repositoryStatements(db)
    .prepare(
      `SELECT * FROM source_dispatch_reservations WHERE ingestion_run_id=? AND settled_at IS NULL ORDER BY id LIMIT 51`,
    )
    .bind(runId);
}
export function captureDispatch(db: CatalogueStore, attemptId: string) {
  return repositoryStatements(db)
    .prepare(
      `SELECT * FROM source_dispatch_reservations WHERE capture_operation_id=? ORDER BY reserved_at DESC,id DESC LIMIT 1`,
    )
    .bind(attemptId);
}
export function storedBodyDispatch(db: CatalogueStore, token: string, runId: string, captureId: string, key: string) {
  return repositoryStatements(db)
    .prepare(
      `SELECT * FROM source_dispatch_reservations WHERE id=? AND ingestion_run_id=?
      AND capture_operation_id=? AND content_object_key=?`,
    )
    .bind(token, runId, captureId, key);
}
export function unsettledRunDispatch(db: CatalogueStore, runId: string) {
  return repositoryStatements(db)
    .prepare("SELECT id FROM source_dispatch_reservations WHERE ingestion_run_id=? AND settled_at IS NULL LIMIT 1")
    .bind(runId);
}
export function unresolvedCaptureResponse(db: CatalogueStore, runId: string) {
  return repositoryStatements(db)
    .prepare(
      "SELECT attempt_id FROM source_capture_operations WHERE ingestion_run_id=? AND state='response_received' LIMIT 1",
    )
    .bind(runId);
}
export function unsettledRawWriter(db: CatalogueStore, runId: string, key: string | null = null) {
  return repositoryStatements(db)
    .prepare(
      `SELECT writer.token FROM evidence_object_writers writer
    WHERE writer.ingestion_run_id=?1 AND writer.completed_at IS NULL AND (?2 IS NULL OR writer.object_key=?2)
    AND EXISTS(SELECT 1 FROM source_capture_operations capture WHERE capture.ingestion_run_id=?1 AND capture.content_object_key=writer.object_key)
    LIMIT 1`,
    )
    .bind(runId, key);
}
export function reserveSourceDispatch(
  db: CatalogueStore,
  input: {
    id: string;
    runId: string;
    requestId: string;
    captureId: string;
    objectKey: string;
    workflow?: CollectionWorkflowAttempt;
    maximumBytes: number;
    at: string;
  },
) {
  const statement = repositoryStatements(db)
    .prepare(
      `INSERT INTO source_dispatch_reservations
    (id,ingestion_run_id,request_id,capture_operation_id,content_object_key,parent_workflow_id,workflow_instance_id,budget_generation,maximum_source_bytes,reserved_at)
    SELECT ?1,?2,?3,?4,?5,?6,?7,policy.generation,?8,?9 FROM ingestion_acquisition_accounts account
    JOIN ingestion_acquisition_policies policy USING(ingestion_run_id)
    WHERE account.ingestion_run_id=?2 AND policy.generation=(SELECT MAX(generation) FROM ingestion_acquisition_policies WHERE ingestion_run_id=?2)
      AND julianday(policy.dispatch_deadline)>julianday('now') AND account.charged_dispatches<policy.max_dispatches
      AND ?8<=policy.max_source_bytes-account.charged_source_bytes-account.reserved_source_bytes
      AND NOT EXISTS(SELECT 1 FROM source_dispatch_reservations WHERE capture_operation_id=?4 AND settled_at IS NULL)
      AND NOT EXISTS(SELECT 1 FROM evidence_object_writers WHERE object_key=?5 AND completed_at IS NULL)
      AND EXISTS(SELECT 1 FROM source_capture_operations WHERE attempt_id=?4 AND ingestion_run_id=?2 AND request_id=?3 AND state='planned')`,
    )
    .bind(
      input.id,
      input.runId,
      input.requestId,
      input.captureId,
      input.objectKey,
      input.workflow?.parentId ?? null,
      input.workflow?.instanceId ?? null,
      input.maximumBytes,
      input.at,
    );
  return atomicRepositoryStatement(db, {
    statement,
    before: [sourceParseAuthorityGuard(db, input.runId, { intent: "collection", workflowAttempt: input.workflow })],
    after: [
      repositoryStatements(db)
        .prepare(
          `UPDATE ingestion_acquisition_accounts SET charged_dispatches=charged_dispatches+1,
        reserved_source_bytes=reserved_source_bytes+? WHERE ingestion_run_id=? AND changes()>0`,
        )
        .bind(input.maximumBytes, input.runId),
      repositoryStatements(db)
        .prepare(
          `INSERT INTO evidence_object_writers(token,ingestion_run_id,object_key,started_at)
          SELECT id,ingestion_run_id,content_object_key,reserved_at FROM source_dispatch_reservations WHERE id=?`,
        )
        .bind(input.id),
    ],
  });
}
export function settleSourceDispatch(db: CatalogueStore, id: string, captureId: string, bytes: number, at: string) {
  const statement = repositoryStatements(db)
    .prepare(
      `UPDATE source_dispatch_reservations SET settled_at=?,charged_source_bytes=?
    WHERE id=? AND capture_operation_id=? AND settled_at IS NULL AND maximum_source_bytes>=?`,
    )
    .bind(at, bytes, id, captureId, bytes);
  return atomicRepositoryStatement(db, {
    statement,
    after: [
      repositoryStatements(db)
        .prepare(
          `UPDATE ingestion_acquisition_accounts SET charged_source_bytes=charged_source_bytes+?1,
      reserved_source_bytes=reserved_source_bytes-(SELECT maximum_source_bytes FROM source_dispatch_reservations WHERE id=?2)
      WHERE ingestion_run_id=(SELECT ingestion_run_id FROM source_dispatch_reservations WHERE id=?2) AND changes()>0`,
        )
        .bind(bytes, id),
      repositoryStatements(db)
        .prepare(
          `UPDATE evidence_object_writers SET completed_at=?1 WHERE token=?2 AND completed_at IS NULL
          AND EXISTS(SELECT 1 FROM source_dispatch_reservations dispatch WHERE dispatch.id=?2
            AND dispatch.capture_operation_id=?3 AND dispatch.settled_at IS NOT NULL
            AND dispatch.ingestion_run_id=evidence_object_writers.ingestion_run_id
            AND dispatch.content_object_key=evidence_object_writers.object_key)`,
        )
        .bind(at, id, captureId),
    ],
  });
}
export function acquisitionPauseStatements(
  db: CatalogueStore,
  input: {
    runId: string;
    requestId: string;
    generation: number | null;
    maximumBytes: number;
    dimension: AcquisitionDimension;
    workflow?: CollectionWorkflowAttempt;
  },
) {
  const event = runEventCommand("collection_paused", { runId: input.runId });
  return [
    runEventStatement(db, {
      event,
      statement: repositoryStatements(db)
        .prepare(
          `UPDATE ingestion_run_current SET ${runEventIdentitySql},state='paused',completed_stage_count=1
      WHERE ingestion_run_id=? AND ${ingestionRunTransitionSql("collecting", "paused")}`,
        )
        .bind(event.eventId, input.runId),
      before: [sourceParseAuthorityGuard(db, input.runId, { intent: "collection", workflowAttempt: input.workflow })],
      guards: [runTransitionGuardStatement(db, { runId: input.runId, from: "collecting", to: "paused" })],
    }),
    repositoryStatements(db)
      .prepare(
        `INSERT INTO ingestion_acquisition_pauses
    SELECT ?1,?2,?3,?4,?5,?6,?7 WHERE EXISTS(SELECT 1 FROM ingestion_run_current WHERE ingestion_run_id=?2 AND last_event_id=?1)`,
      )
      .bind(
        event.eventId,
        input.runId,
        input.generation,
        input.requestId,
        input.maximumBytes,
        input.dimension,
        event.occurredAt,
      ),
  ];
}
export function acquisitionIntegrityGuard(db: CatalogueStore, runId: string) {
  return runCurrentIntegrityGuardStatement(db, runId);
}
