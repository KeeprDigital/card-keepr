// Public surface of the `curated` cluster: Curated Revision Proposals,
// Curated Revisions, and their application during reconciliation. The
// provenance types live in `shared`. See ../README.md (issue #96).

export {
  CuratedRevisionSourceChangeError,
  CuratedDraftSourceChangeError,
  applyPinnedCuratedRevisionsToDraft,
  applyPinnedCuratedRevisions,
  assertCuratedGamesUnblocked,
  createCuratedRevision,
  curatedPublicationStatements,
  curatedRevisionInspectionForRun,
  curatedRevisionPinStatementsForNewRun,
  curatedRevisionSetForRun,
  curatedSourceAbsence,
  listCuratedRevisions,
  pinCuratedRevisionsForRun,
  prepareCuratedRevisionRunStart,
  reaffirmCuratedRevision,
  retireCuratedRevision,
  showCuratedRevision,
  stripCuratedRevisionEffects,
  restoreCuratedEntitySourceFields,
  supersedeCuratedRevision,
  validateCuratedRevision,
} from "./curated-revisions";

export { curatedRoutes } from "./routes";

export { curatedRunStartGuardStatement } from "./curated-guard-repository";

export { CuratedConflictStorageError } from "./curated-conflict-preparation";
