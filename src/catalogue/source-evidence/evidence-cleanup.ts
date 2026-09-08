import { deleteSourceAuxiliaryForObject } from "./source-record-auxiliary-repository";
import { deleteSourceRecordsForObject } from "./source-record-repository";
import { AdministrationProblem, type CatalogueStore, sha256Text } from "../shared";
import {
  cleanupById,
  cleanupByKey,
  cleanupRun,
  insertCleanup,
  nextCleanupObject,
  finishCleanup,
  cleanupObject,
  claimCleanupObject,
  deletedCleanupObject,
  cleanupResultStatements,
  nextWaitingCleanupObject,
  waitingCleanupReason,
  cleanupResults,
  pauseCleanup,
  cleanupDeleteGuard,
  openEvidenceWriter,
  authorizeCleanupDelete,
  attemptCleanup,
  resumeCleanup,
  completeEvidenceObjectWrite,
} from "./evidence-cleanup-repository";

export type Cleanup = {
  scope: "capture" | "staging";
  preparation_id: string | null;
  id: string;
  ingestion_run_id: string;
  idempotency_key: string;
  retention_days: number;
  terminal_at: string;
  eligible_at: string;
  created_at: string;
  state: "pending" | "running" | "paused" | "completed";
  cursor: string;
  retry_cursor: string;
  deleted_objects: number;
  protected_objects: number;
  generation: number;
  failure_code: string | null;
};
export async function inspectEvidenceCleanup(db: CatalogueStore, id: string): Promise<Cleanup> {
  const row = await cleanupById(db, id).first<Cleanup>();
  if (!row) throw new AdministrationProblem(404, "evidence_cleanup_not_found", "Evidence cleanup was not found.");
  return row;
}
export async function beginEvidenceCleanup(db: CatalogueStore, run: string, key: string, days: unknown, at: string) {
  const retention = days === undefined ? 30 : days;
  if (typeof retention !== "number" || !Number.isInteger(retention) || retention < 1 || retention > 36500)
    throw new AdministrationProblem(422, "invalid_parameter", "retention_days must be an integer from 1 to 36500.");
  const prior = await cleanupByKey(db, key).first<Cleanup>();
  if (prior) return matchingCleanupIntent(prior, "capture", run, retention);
  const source = await cleanupRun(db, run).first<{ state: string; terminal_at: string | null }>();
  if (!source) throw new AdministrationProblem(404, "ingestion_run_not_found", "The Ingestion Run was not found.");
  const eligible = source.terminal_at
    ? new Date(Date.parse(source.terminal_at) + retention * 86400000).toISOString()
    : null;
  if (!["failed", "rejected", "expired"].includes(source.state) || !eligible || at < eligible)
    throw new AdministrationProblem(
      409,
      "evidence_cleanup_not_eligible",
      "Unused terminal evidence has not reached its retention boundary.",
    );
  const id = `cleanup_${await sha256Text(key)}`;
  await insertCleanup(db, id, run, key, retention, source.terminal_at!, eligible, at).run();
  return matchingCleanupIntent(await inspectEvidenceCleanup(db, id), "capture", run, retention);
}
/** One unit performs at most four metadata/deletion transactions and never reads object bodies. */
export async function advanceEvidenceCleanup(db: CatalogueStore, bucket: R2Bucket, id: string, at: string) {
  for (let unit = 0; unit < 4; unit++) {
    const intent = await inspectEvidenceCleanup(db, id);
    if (intent.state === "completed") return intent;
    let next = await nextCleanupObject(db, intent.ingestion_run_id, intent.cursor).first<{ object_key: string }>();
    const retry = !next;
    if (!next) next = await nextWaitingCleanupObject(db, id, intent.retry_cursor).first<{ object_key: string }>();
    if (!next) {
      const waiting = await waitingCleanupReason(db, id).first<{ reason: string }>();
      if (waiting) {
        await pauseCleanup(db, id, waiting.reason).run();
        return inspectEvidenceCleanup(db, id);
      }
      await finishCleanup(db, id, at).run();
      return inspectEvidenceCleanup(db, id);
    }
    let tombstone = await cleanupObject(db, next.object_key).first<{ state: string }>();
    if (!tombstone) {
      try {
        await claimCleanupObject(db, id, next.object_key, at).run();
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("evidence_cleanup_reference_protected")) throw error;
        await db.batch(cleanupResultStatements(db, id, next.object_key, "protected", "retained_reference", retry));
        continue;
      }
      tombstone = await cleanupObject(db, next.object_key).first<{ state: string }>();
      if (!tombstone) throw new Error("Cleanup claim did not persist.");
    }
    const writer = await openEvidenceWriter(db, next.object_key).first<{
      token: string;
      multipart_upload_id: string | null;
    }>();
    if (writer) {
      let settled = (await bucket.head(next.object_key))?.customMetadata?.cleanup_writer_token === writer.token;
      if (!settled && writer.multipart_upload_id) {
        // Abort completion is a storage acknowledgement, not a lease timeout.
        // Once it succeeds this exact upload can no longer complete later.
        await bucket.resumeMultipartUpload(next.object_key, writer.multipart_upload_id).abort();
        settled = true;
      }
      if (settled) await completeEvidenceObjectWrite(db, writer.token, at).run();
      else {
        await db.batch(
          cleanupResultStatements(db, id, next.object_key, "waiting", "evidence_cleanup_writer_unsettled", retry),
        );
        continue;
      }
      // Multiple concurrent registrations each require their own acknowledgement.
      if (await openEvidenceWriter(db, next.object_key).first()) {
        await db.batch(
          cleanupResultStatements(db, id, next.object_key, "waiting", "evidence_cleanup_writer_unsettled", retry),
        );
        continue;
      }
    }
    if (tombstone.state === "reserved") {
      try {
        await db.batch([attemptCleanup(db, id, at), authorizeCleanupDelete(db, next.object_key)]);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("evidence_cleanup_backup_protected")) throw error;
        await db.batch(
          cleanupResultStatements(
            db,
            id,
            next.object_key,
            "waiting",
            "evidence_cleanup_waiting_backup_retention",
            retry,
          ),
        );
        continue;
      }
    }
    if (tombstone.state !== "deleted") {
      // New reference insertions are already fenced by the durable tombstone.
      // Recheck the reference closure directly adjacent to the physical delete.
      await cleanupDeleteGuard(db, next.object_key).first();
      try {
        await bucket.delete(next.object_key);
        const removed = await deleteSourceRecordsForObject(db, next.object_key).run();
        if (removed.meta.changes > 0) continue;
        if ((await deleteSourceAuxiliaryForObject(db, next.object_key).run()).meta.changes > 0) continue;
        await deletedCleanupObject(db, next.object_key, at).run();
      } catch {
        await pauseCleanup(db, id, "evidence_cleanup_storage_retry_required").run();
        return inspectEvidenceCleanup(db, id);
      }
    }
    await db.batch(cleanupResultStatements(db, id, next.object_key, "deleted", null, retry));
  }
  return inspectEvidenceCleanup(db, id);
}

export async function assertEvidenceAvailable(db: CatalogueStore, key: string) {
  if (await cleanupObject(db, key).first())
    throw new AdministrationProblem(
      410,
      "evidence_reclaimed",
      "The unused terminal evidence bytes were reclaimed; their audit identity is retained.",
    );
}

export async function inspectEvidenceCleanupResults(db: CatalogueStore, id: string, after: string) {
  await inspectEvidenceCleanup(db, id);
  return (await cleanupResults(db, id, after).all<{ object_key: string; state: string; reason: string | null }>())
    .results;
}
export async function resumeEvidenceCleanup(db: CatalogueStore, id: string, generation: unknown) {
  if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0)
    throw new AdministrationProblem(422, "invalid_parameter", "expected_generation must be a nonnegative integer.");
  const current = await inspectEvidenceCleanup(db, id);
  if (current.state === "completed") return current;
  if (current.generation !== generation && current.generation !== generation + 1)
    throw new AdministrationProblem(409, "evidence_cleanup_generation_conflict", "Cleanup generation changed.");
  await resumeCleanup(db, id, generation).run();
  return inspectEvidenceCleanup(db, id);
}

export async function pauseEvidenceCleanup(db: CatalogueStore, id: string, generation: number, code: string) {
  await pauseCleanup(db, id, code, generation).run();
  return inspectEvidenceCleanup(db, id);
}

/** Validate the persisted winner both for an early replay and an INSERT race. */
export function matchingCleanupIntent(
  intent: Cleanup,
  scope: Cleanup["scope"],
  owner: string,
  retention: number,
): Cleanup {
  if (
    intent.scope !== scope ||
    (scope === "capture" ? intent.ingestion_run_id : intent.preparation_id) !== owner ||
    intent.retention_days !== retention
  )
    throw new AdministrationProblem(409, "idempotency_conflict", "Cleanup intent differs from its retained request.");
  return intent;
}
