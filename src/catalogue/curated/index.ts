// Public surface of the `curated` cluster: Curated Revision Proposals,
// Curated Revisions, and their application during reconciliation. The
// provenance types live in `shared`. See ../README.md (issue #96).

export {
  CuratedRevisionSourceChangeError,
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
  supersedeCuratedRevision,
  validateCuratedRevision,
} from "./curated-revisions";
