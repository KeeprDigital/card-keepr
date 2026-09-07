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
) {
  const checkpoint = await reconciliationCheckpoint<Cursor>(database, runId, "curated_revisions");
  if (checkpoint) {
    official.resumeAt(checkpoint.value.official);
    curated.resumeAt(checkpoint.value.curated);
  }
  const cursor = checkpoint?.value.progress ?? {
    stage: "strip",
    kind: 0,
    after: "",
    revision: -1,
    sourceChanged: false,
  };
  let ordinal = (checkpoint?.ordinal ?? -1) + 1;
  let records = 0,
    bytes = 0;
  await applyPinnedCuratedRevisionsToDraft(database, runId, official, curated, observedAt, {
    cursor,
    checkpoint: async (progress, record) => {
      if (record !== undefined) {
        records++;
        bytes += new TextEncoder().encode(canonicalJson(record)).byteLength;
      }
      if (record !== undefined && records < 4 && bytes < 512000) return;
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
  });
}
