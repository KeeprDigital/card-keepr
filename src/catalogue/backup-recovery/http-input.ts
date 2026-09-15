import type { z } from "@hono/zod-openapi";
import type { recoveryAcceptCommand, recoveryBeginCommand } from "./http-contract";
import type { CatalogueRecoveryAcceptanceIntent, CatalogueRecoveryBeginIntent } from "./recovery";

export function recoveryBeginIntent(body: z.infer<typeof recoveryBeginCommand>): CatalogueRecoveryBeginIntent {
  return {
    recoveryId: body.recovery_id,
    method: body.method,
    targetRevisionId: body.target_revision_id,
    targetBookmark: body.target_bookmark,
    targetDigest: body.target_digest,
    backupAttemptId: body.backup_attempt_id,
    expectedCurrentRevisionId: body.expected_current_revision_id,
    idempotencyKey: body.idempotency_key,
    ...(body.linked_operation_id === undefined ? {} : { linkedOperationId: body.linked_operation_id }),
  };
}
export function recoveryAcceptanceIntent(
  body: z.infer<typeof recoveryAcceptCommand>,
  boundDatabaseId: string,
): CatalogueRecoveryAcceptanceIntent {
  return {
    expectedRestoredRevisionId: body.expected_restored_revision_id,
    targetDigest: body.target_digest,
    confirmationRecoveryId: body.confirmation_recovery_id,
    idempotencyKey: body.idempotency_key,
    boundDatabaseId,
  };
}
