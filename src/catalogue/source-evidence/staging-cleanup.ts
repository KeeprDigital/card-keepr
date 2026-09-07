import { AdministrationProblem, type CatalogueStore, sha256Text } from "../shared";
import { inspectEvidenceCleanup } from "./evidence-cleanup";
import {
  cleanupByKey,
  cleanupResultStatements,
  nextWaitingCleanupObject,
  waitingCleanupReason,
  pauseCleanup,
  finishCleanup,
  attemptCleanup,
} from "./evidence-cleanup-repository";
import {
  stagingPreparation,
  insertStagingCleanup,
  nextStagingInventory,
  stagingObject,
  reserveStagingObject,
  promoteStagingDelete,
  openStagingTickets,
  beginStagingDelete,
  finishStagingDelete,
  type StagingObject,
} from "./staging-cleanup-repository";

export async function beginStagingCleanup(
  db: CatalogueStore,
  preparation: string,
  key: string,
  days: unknown,
  at: string,
) {
  const retention = days === undefined ? 30 : days;
  if (typeof retention !== "number" || !Number.isSafeInteger(retention) || retention < 1 || retention > 36500)
    throw new AdministrationProblem(422, "invalid_parameter", "retention_days must be an integer from 1 to 36500.");
  const prior = await cleanupByKey(db, key).first<{ id: string; preparation_id: string; retention_days: number }>();
  if (prior) {
    if (prior.preparation_id !== preparation || prior.retention_days !== retention)
      throw new AdministrationProblem(409, "idempotency_conflict", "Cleanup intent differs from its retained request.");
    return inspectEvidenceCleanup(db, prior.id);
  }
  const owner = await stagingPreparation(db, preparation).first<{ terminal_at: string | null; state: string }>();
  if (!owner) throw new AdministrationProblem(404, "reconciliation_not_found", "Preparation was not found.");
  if (
    !["failed", "abandoned"].includes(owner.state) ||
    !owner.terminal_at ||
    Date.parse(owner.terminal_at) + retention * 86400000 > Date.parse(at)
  )
    throw new AdministrationProblem(
      409,
      "evidence_cleanup_not_eligible",
      "The abandoned preparation has not reached its retention boundary.",
    );
  const id = `cleanup_${await sha256Text(key)}`;
  await insertStagingCleanup(db, id, preparation, key, retention, at).run();
  return inspectEvidenceCleanup(db, id);
}

export async function advanceStagingCleanup(
  db: CatalogueStore,
  buckets: { PRINTING_IMAGES: R2Bucket; CATALOGUE_EXPORTS: R2Bucket },
  id: string,
  at: string,
) {
  for (let unit = 0; unit < 4; unit++) {
    const intent = await inspectEvidenceCleanup(db, id);
    if (intent.state === "completed") return intent;
    let next = await nextStagingInventory(db, intent.preparation_id!, intent.cursor).first<{ object_key: string }>();
    const retry = !next;
    if (!next) next = await nextWaitingCleanupObject(db, id, intent.retry_cursor).first<{ object_key: string }>();
    if (!next) {
      const waiting = await waitingCleanupReason(db, id).first<{ reason: string }>();
      if (waiting) await pauseCleanup(db, id, waiting.reason).run();
      else await finishCleanup(db, id, at).run();
      return inspectEvidenceCleanup(db, id);
    }
    const key = next.object_key;
    let object = await stagingObject(db, key).first<StagingObject>();
    if (!object) throw new Error("Staging ownership inventory is missing.");
    const result = async (state: "waiting" | "protected" | "deleted", reason: string | null) => {
      await db.batch(cleanupResultStatements(db, id, key, state, reason, retry));
    };
    if (object.state === "available") {
      try {
        await reserveStagingObject(db, id, key, object.incarnation, at).run();
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("staging_reference_protected")) throw error;
        await result("protected", "retained_reference");
        continue;
      }
      object = (await stagingObject(db, key).first<StagingObject>())!;
    }
    if (object.cleanup_id !== id) {
      await result("protected", "other_incarnation_or_cleanup");
      continue;
    }
    if (object.state === "deleted") {
      await result("deleted", null);
      continue;
    }
    if (await openStagingTickets(db, key, object.incarnation).first()) {
      await result("waiting", "staging_ticket_unsettled");
      continue;
    }
    if (object.state === "reserved") {
      try {
        await db.batch([attemptCleanup(db, id, at), promoteStagingDelete(db, id, key, object.incarnation)]);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("staging_delete_waiting")) throw error;
        await result("waiting", "evidence_cleanup_waiting_backup_retention");
        continue;
      }
    }
    const token = crypto.randomUUID();
    const claim = await beginStagingDelete(db, id, key, object.incarnation, token, at).run();
    if (!claim.meta.changes) {
      await result("waiting", "staging_incarnation_changed");
      continue;
    }
    // After acquiring this exact ticket, resurrection is impossible until this
    // callback conclusively returns. Ambiguous rejection leaves the ticket open.
    try {
      await buckets[object.binding].delete(object.object_key);
    } catch {
      await result("waiting", "staging_delete_outcome_unknown");
      continue;
    }
    await db.batch(finishStagingDelete(db, key, object.incarnation, token, at));
    const final = (await stagingObject(db, key).first<StagingObject>())!;
    await result(
      final.state === "deleted" ? "deleted" : "waiting",
      final.state === "deleted" ? null : "staging_ticket_unsettled",
    );
  }
  return inspectEvidenceCleanup(db, id);
}
