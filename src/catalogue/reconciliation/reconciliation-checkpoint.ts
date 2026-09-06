import { type CatalogueStore, canonicalJson, sha256Text } from "../shared";
import { documentStorage } from "./reconciliation-document";
import {
  exactReconciliationCheckpointStatement,
  latestReconciliationCheckpointStatement,
  retainReconciliationCheckpointStatement,
} from "./reconciliation-checkpoint-repository";

type CheckpointRow = { ordinal: number; content: string; sha256: string };
export async function reconciliationCheckpoint<T>(
  database: CatalogueStore,
  runId: string,
  phase: string,
): Promise<{ ordinal: number; value: T } | null> {
  const row = await documentStorage(() =>
    latestReconciliationCheckpointStatement(database, runId, phase).first<CheckpointRow>(),
  );
  if (!row) return null;
  if ((await sha256Text(row.content)) !== row.sha256)
    throw new Error("Reconciliation checkpoint failed integrity verification.");
  return { ordinal: row.ordinal, value: JSON.parse(row.content) as T };
}
export async function retainReconciliationCheckpoint(
  database: CatalogueStore,
  runId: string,
  phase: string,
  ordinal: number,
  value: unknown,
): Promise<void> {
  const content = canonicalJson(value);
  if (new TextEncoder().encode(content).byteLength > 65536)
    throw new Error("reconciliation_capacity_exceeded: one continuation checkpoint exceeds 64 KiB.");
  const digest = await sha256Text(content);
  await documentStorage(() =>
    retainReconciliationCheckpointStatement(database, runId, phase, ordinal, content, digest).run(),
  );
  const retained = await documentStorage(() =>
    exactReconciliationCheckpointStatement(database, runId, phase, ordinal).first<CheckpointRow>(),
  );
  if (retained?.content !== content || retained.sha256 !== digest)
    throw new Error("Reconciliation checkpoint replay changed immutable content.");
}
