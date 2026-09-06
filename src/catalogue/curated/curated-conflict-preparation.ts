import { type CatalogueStore, canonicalJson, sha256Text } from "../shared";
import { curatedRevisionStatusStatement } from "./curated-repository";
import {
  nextPreparedCuratedConflictStatement,
  preparedCuratedConflictStatement,
  retainCuratedConflictStatement,
} from "./curated-conflict-preparation-repository";

export class CuratedConflictStorageError extends Error {
  constructor(cause: unknown) {
    super("Curated conflict preparation storage is temporarily unavailable.", { cause });
  }
}
async function storage<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    throw new CuratedConflictStorageError(cause);
  }
}
export type PendingConflict = {
  conflict_id: string;
  conflict_digest: string;
  run_id: string;
  previous_source_digest: string;
  observed_source_digest: string;
};
export async function sourceChangeDetails(
  runId: string,
  revisionId: string,
  previousDigest: string,
  reviewedSourceValue: unknown,
): Promise<PendingConflict> {
  const observed = await sha256Text(canonicalJson(reviewedSourceValue));
  const identity = {
    run_id: runId,
    revision_id: revisionId,
    previous_source_digest: previousDigest,
    observed_source_digest: observed,
  };
  const conflictId = `crconf_${await sha256Text(canonicalJson(identity))}`;
  return {
    conflict_id: conflictId,
    conflict_digest: await sha256Text(canonicalJson({ conflict_id: conflictId, ...identity })),
    run_id: runId,
    previous_source_digest: previousDigest,
    observed_source_digest: observed,
  };
}
export function sourceChangeDiagnostic(revisionId: string, conflict: PendingConflict): Record<string, unknown> {
  return {
    code: "curated_revision_reconfirmation_required",
    detail: `Official Source evidence changed for Curated Revision ${revisionId}.`,
    curated_revision_id: revisionId,
    conflict_id: conflict.conflict_id,
    conflict_digest: conflict.conflict_digest,
  };
}
type PreparedConflict = { revisionId: string; eventVersion: number; details: PendingConflict; createdAt: string };
type PreparedRow = { revision_id: string; content: string; sha256: string };
async function verified(row: PreparedRow): Promise<PreparedConflict> {
  if ((await sha256Text(row.content)) !== row.sha256)
    throw new Error("Prepared Curated conflict failed integrity verification.");
  const value = JSON.parse(row.content) as PreparedConflict;
  if (value.revisionId !== row.revision_id) throw new Error("Prepared Curated conflict identity is invalid.");
  return value;
}

/** Stage each conflict independently; the terminal run state makes them visible atomically. */
export class CuratedConflictPreparation {
  constructor(
    private database: CatalogueStore,
    private runId: string,
    private observedAt: string,
  ) {}
  async record(revisionId: string, previousDigest: string, reviewedSourceValue: unknown): Promise<void> {
    const details = await sourceChangeDetails(this.runId, revisionId, previousDigest, reviewedSourceValue);
    const existing = await storage(() =>
      preparedCuratedConflictStatement(this.database, this.runId, revisionId).first<PreparedRow>(),
    );
    if (existing) {
      const retained = await verified(existing);
      if (canonicalJson(retained.details) !== canonicalJson(details) || retained.createdAt !== this.observedAt)
        throw new Error("Curated conflict preparation replay changed its immutable content.");
      return;
    }
    const revision = await storage(() =>
      curatedRevisionStatusStatement(this.database, { revisionId }).first<{ status: string; event_version: number }>(),
    );
    if (revision?.status === "reconfirmation_required") return;
    const content = canonicalJson({
      revisionId,
      eventVersion: (revision?.event_version ?? 0) + 1,
      details,
      createdAt: this.observedAt,
    });
    const digest = await sha256Text(content);
    await storage(() => retainCuratedConflictStatement(this.database, this.runId, revisionId, content, digest).run());
    const retained = await storage(() =>
      preparedCuratedConflictStatement(this.database, this.runId, revisionId).first<PreparedRow>(),
    );
    if (retained?.content !== content || retained.sha256 !== digest)
      throw new Error("Curated conflict preparation replay changed its immutable content.");
  }
  async *diagnostics(): AsyncGenerator<Record<string, unknown>> {
    let id = "";
    while (true) {
      const row = await storage(() =>
        nextPreparedCuratedConflictStatement(this.database, this.runId, id).first<PreparedRow>(),
      );
      if (!row) return;
      const retained = await verified(row);
      yield sourceChangeDiagnostic(retained.revisionId, retained.details);
      id = row.revision_id;
    }
  }
}
