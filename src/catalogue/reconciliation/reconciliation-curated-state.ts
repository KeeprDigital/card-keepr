import { type CatalogueStore, type CatalogueCandidate } from "../shared";
import {
  applyPinnedCuratedRevisions,
  applyPinnedCuratedRevisionsToDraft,
  curatedRevisionSetForRun,
  CuratedDraftSourceChangeError,
  CuratedRevisionSourceChangeError,
} from "../curated";
import { ReconciliationCandidateState } from "./reconciliation-candidate-state";

export async function applyCuratedCandidateState(
  database: CatalogueStore,
  runId: string,
  candidate: CatalogueCandidate,
  observedAt: string,
): Promise<CatalogueCandidate> {
  const pins = await curatedRevisionSetForRun(database, runId);
  // The legacy aggregate caller still owns validation when there are no curated edits.
  if (!pins?.revision_ids.length)
    return applyPinnedCuratedRevisions(database, runId, candidate, observedAt, { deferSourceChangeFailure: true });
  const official = new ReconciliationCandidateState(database, runId, "before_curated");
  await official.seed(candidate);
  const result = new ReconciliationCandidateState(database, runId, "curated", official);
  try {
    await applyPinnedCuratedRevisionsToDraft(database, runId, official, result, observedAt);
  } catch (error) {
    if (!(error instanceof CuratedDraftSourceChangeError)) throw error;
    throw new CuratedRevisionSourceChangeError(
      await official.candidate(candidate),
      error.atomicStatements,
      error.diagnostics,
    );
  }
  return result.candidate(candidate);
}
