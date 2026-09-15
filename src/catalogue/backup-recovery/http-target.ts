import type { z } from "@hono/zod-openapi";
import { AdministrationProblem, type CatalogueStore } from "../shared";
import { acknowledgedCatalogueBackupRequest } from "./backup-workflow";
import type { backupRecoveryTargetCommand } from "./http-contract";
import { recoveryAcceptanceIntent, recoveryBeginIntent } from "./http-input";
import {
  acknowledgedCatalogueRecoveryAcceptance,
  acknowledgedCatalogueRecoveryBegin,
  acknowledgedCatalogueRecoveryVerification,
  inspectCatalogueRecovery,
} from "./recovery";

/** Confirm the same command bytes the owner will send. Only exact retained
 * intent may pass a changed current revision; the mutation still owns all
 * recovery effects, fences, provider work and durable acceptance. */
export async function backupRecoveryConfirmationBinding(
  database: CatalogueStore,
  backups: R2Bucket,
  input: z.infer<typeof backupRecoveryTargetCommand>,
  currentRevisionId: unknown,
  target: { environment: string; catalogueDatabaseId: string },
): Promise<Record<string, unknown>> {
  if ("backup" in input) {
    const body = input.backup;
    if (!(await acknowledgedCatalogueBackupRequest(database, body))) current(body.expected_current_revision_id);
    return body;
  }
  const { recovery } = input;
  if (recovery.action === "begin") {
    const body = recovery.input;
    if (body.environment !== target.environment)
      mismatch("The recovery environment does not match this administration target.");
    if (!(await acknowledgedCatalogueRecoveryBegin(database, backups, recoveryBeginIntent(body))))
      current(body.expected_current_revision_id);
    return body;
  }
  const body = recovery.input;
  const acknowledged =
    recovery.action === "verify"
      ? await acknowledgedCatalogueRecoveryVerification(database, backups, recovery.recovery_id, {
          targetDigest: body.target_digest,
          idempotencyKey: body.idempotency_key,
        })
      : await acknowledgedCatalogueRecoveryAcceptance(
          database,
          backups,
          recovery.recovery_id,
          recoveryAcceptanceIntent(recovery.input, target.catalogueDatabaseId),
        );
  if (!acknowledged) {
    const document = await inspectCatalogueRecovery(database, backups, recovery.recovery_id);
    if (
      document.target_digest !== body.target_digest ||
      (recovery.action === "accept" && document.target_revision_id !== recovery.input.expected_restored_revision_id)
    )
      mismatch("The recovery operation does not match the supplied exact target evidence.");
    if (
      currentRevisionId !== document.expected_current_revision_id &&
      currentRevisionId !== document.target_revision_id
    )
      mismatch("The current catalogue does not match the recovery source or restored Catalogue Revision.");
  }
  return { recovery_id: recovery.recovery_id, ...body };

  function current(expected: string) {
    if (currentRevisionId !== expected) mismatch("The expected current Catalogue Revision is stale.");
  }
}
function mismatch(detail: string): never {
  throw new AdministrationProblem(409, "production_target_mismatch", detail);
}
