import { ReconciliationRecordCollection } from "./reconciliation-record-collection";
import { type CatalogueStore, canonicalJson } from "../shared";
import { type CuratedDraftCursor, applyPinnedCuratedRevisionsToDraft } from "../curated";
import type { ReconciliationCandidateState } from "./reconciliation-candidate-state";
import { reconciliationCheckpoint, retainReconciliationCheckpoint } from "./reconciliation-checkpoint";
import { ReconciliationContinuation } from "./reconciliation-continuation";

type Cursor = {
  progress: CuratedDraftCursor;
  official: ReconciliationCandidateState["positions"];
  curated: ReconciliationCandidateState["positions"];
};

export async function prepareCuratedDraft(
  database: CatalogueStore,
  runId: string,
  official: ReconciliationCandidateState,
  curated: ReconciliationCandidateState,
  observedAt: string,
  yieldAtCheckpoint: boolean,
  independentGame = false,
  freshSourceOnly = false,
) {
  const checkpoint = await reconciliationCheckpoint<Cursor>(database, runId, "curated_revisions");
  if (checkpoint) {
    official.resumeAt(checkpoint.value.official);
    curated.resumeAt(checkpoint.value.curated);
  }
  const cursor = checkpoint?.value.progress ?? {
    // Fresh normalized source entities cannot carry prior curated provenance.
    stage: freshSourceOnly ? "compare" : "strip",
    kind: 0,
    after: "",
    revision: -1,
    sourceChanged: false,
  };
  let ordinal = (checkpoint?.ordinal ?? -1) + 1;
  let records = 0,
    bytes = 0;
  await applyPinnedCuratedRevisionsToDraft(
    database,
    runId,
    official,
    curated,
    observedAt,
    {
      cursor,
      checkpoint: async (progress, record) => {
        if (record !== undefined) {
          records++;
          bytes += new TextEncoder().encode(canonicalJson(record)).byteLength;
        }
        const recordLimit = progress.stage === "validate" && progress.kind < 5 ? 32 : 4;
        if (record !== undefined && records < recordLimit && bytes < 512000) return;
        await retainReconciliationCheckpoint(database, runId, "curated_revisions", ordinal, {
          progress,
          official: official.positions,
          curated: curated.positions,
        } satisfies Cursor);
        if (yieldAtCheckpoint) throw new ReconciliationContinuation({ phase: "curated_revisions", ordinal });
        ordinal++;
        records = 0;
        bytes = 0;
      },
    },
    independentGame,
  );
}

/** Retain conflict diagnostics once in revision order before sorting or hashing them. */
export async function prepareCuratedConflictDiagnostics(
  database: CatalogueStore,
  runId: string,
  source: (after?: string) => AsyncIterable<Record<string, unknown>>,
  yieldAtCheckpoint: boolean,
) {
  const records = new ReconciliationRecordCollection<Record<string, unknown>>(
    database,
    runId,
    "curated_conflict_diagnostics",
    false,
  );
  type Progress = { after: string; complete: boolean; records: typeof records.cursor };
  const checkpoint = await reconciliationCheckpoint<Progress>(database, runId, "curated_diagnostics");
  const cursor = checkpoint?.value ?? { after: "", complete: false, records: records.cursor };
  records.resumeAt(cursor.records);
  if (cursor.complete) return records;
  let ordinal = (checkpoint?.ordinal ?? -1) + 1;
  let work = 0,
    bytes = 0;
  const save = async () => {
    cursor.records = records.cursor;
    await retainReconciliationCheckpoint(database, runId, "curated_diagnostics", ordinal, cursor);
    if (yieldAtCheckpoint) throw new ReconciliationContinuation({ phase: "curated_diagnostics", ordinal });
    ordinal++;
    work = 0;
    bytes = 0;
  };
  for await (const diagnostic of source(cursor.after)) {
    const size = new TextEncoder().encode(canonicalJson(diagnostic)).byteLength;
    if (work && bytes + size > 512000) await save();
    await records.push(diagnostic);
    cursor.after = String(diagnostic.curated_revision_id);
    bytes += size;
    if (++work >= 4 || bytes >= 512000) await save();
  }
  cursor.complete = true;
  await save();
  return records;
}
