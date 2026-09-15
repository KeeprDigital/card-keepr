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
      `SELECT account.*,policy.generation,policy.max_dispatches,
    policy.max_source_bytes,policy.dispatch_deadline FROM ingestion_acquisition_accounts account
    JOIN ingestion_acquisition_policies policy USING(ingestion_run_id)
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
export function unsettledRequestDispatch(db: CatalogueStore, runId: string, requestId: string) {
  return repositoryStatements(db)
    .prepare(
      "SELECT id FROM source_dispatch_reservations WHERE ingestion_run_id=? AND request_id=? AND settled_at IS NULL LIMIT 1",
    )
    .bind(runId, requestId);
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
