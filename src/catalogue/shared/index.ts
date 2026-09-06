export { MissingObjectError } from "./missing-object-error";
// Public surface of the `shared` cluster: leaf helpers and domain-type
// modules every other cluster may import. Nothing here imports another
// cluster. See ../README.md for the cluster map (issue #96).

export {
  administrationClaimGuardStatement,
  administrationOutcomeGuardStatement,
} from "./administration-guards-repository";
export { AdministrationProblem } from "./administration-problem";
export { isIsoCalendarDate } from "./calendar-date";
// The Catalogue Candidate's shape (the leaf types from issue #90).
export {
  type CatalogueCandidate,
  type CatalogueCard,
  type CatalogueDistributionContext,
  type CatalogueErratum,
  type CataloguePrinting,
  type CataloguePrintingImage,
  type CatalogueProduct,
  type CatalogueRelease,
  type CatalogueSourceCheck,
  catalogueCandidateContract,
  type EvidenceCategory,
  type ProductAuthorityClass,
  type ProductDisagreement,
  type ProductEntityReference,
  type ProductEvidenceResource,
  type ProductReference,
  type ProductRelationship,
  type ProductSourceObservation,
  type ProductWithdrawal,
  type ReleasePrecision,
  type ReleaseStatus,
  type SupportedGame,
} from "./catalogue-candidate-types";
export {
  atomicRepositoryStatement,
  type CatalogueStore,
  catalogueEnvironment,
  catalogueStore,
  guardedCatalogueStore,
  repositoryStatements,
} from "./catalogue-store-repository";
export { consumerContent } from "./consumer-content";
export type {
  CuratedEvidence,
  CuratedFieldTarget,
  CuratedProvenance,
  CuratedProvenanceBearing,
  CuratedRelationshipTarget,
} from "./curated-provenance";
export { type DocumentSchema, decodeDocument } from "./document-decoder";
export {
  deterministicGzip,
  deterministicGzipStream,
} from "./export-compression";
export {
  CatalogueExportLimitError,
  maximumCatalogueExportBytes,
  maximumCatalogueExportObjectBytes,
  maximumExportComponentBytes,
  maximumExportRecordBytes,
} from "./export-limits";
export {
  catalogueRevisionIdentity,
  evidenceRunIdentity,
  replayByDigest,
} from "./idempotent-identities";
export { runStartGuardStatement, runTransitionGuardStatement } from "./ingestion-guards-repository";
export {
  createRunEventStatement,
  expireRunEventsStatement,
  foldRunEvents,
  rebuildRunProjection,
  releaseTerminalRunEventLockStatement,
  runEventCommand,
  runEventIdentitySql,
  runEventStatement,
  verifiedRunCurrentSql,
} from "./ingestion-run-event-repository";
export {
  projectIngestionRunEvent,
  type RunCurrent,
  type RunEventRow,
  runCompletedStageCount,
  runCurrentColumns,
} from "./ingestion-run-events";
export {
  activeRunStages,
  assertIngestionRunTransition,
  canTransitionIngestionRun,
  IngestionRunState,
  type IngestionRunTransitionFacts,
  ingestionRunStates,
  ingestionRunTerminatedFailureCode,
  ingestionRunTransitionSources,
  ingestionRunTransitionSql,
  ingestionRunTransitions,
  isIngestionRunState,
  isTerminalIngestionRunState,
} from "./ingestion-run-state";
export { operationalDiagnostics } from "./operational-diagnostics";
// D1 payload chunking and the guarded atomic batch, consumed by every
// cluster that writes publication statements.
export {
  byteBoundedJsonArrays,
  chunkedPayloadMarker,
  guardedAtomicBatch,
  payloadChunkStatements,
  retainedPayload,
  retainedPayloadChunks,
} from "./reconciliation-payload";
// Game Profile contract helpers, consumed by curated, export,
// and reconciliation alike.
export {
  canonicalProfileAttributes,
  exportedGameProfileSchema,
  gameProfileFilterValue,
  gameProfileForGame,
  type ProfileWarning,
  rawSourceValue,
  requiredProfileContract,
  sourceFieldWarning,
  sourceVocabularyWarning,
} from "./reconciliation-profile";
export { isReleaseActor, isReleaseDigest, isReleaseHead, isReleaseIdentity } from "./release-input-shapes.mjs";
export {
  canonicalJson,
  canonicalNdjson,
  compareUtf8,
  sha256,
  sha256Text,
  utf8,
} from "./serialization";
export { SPINE_REVISION_ID } from "./spine-revision.mjs";
export { StreamingSha256 } from "./streaming-sha256";
export {
  inspectWorkflowInstance,
  isWorkflowInstanceNotFound,
  type WorkflowStatus,
  workflowDriver,
} from "./workflow-driver";
export { observeWorkflowProgress, type WorkflowProgress } from "./workflow-progress";
export { advancesCollectionProgress, type WorkflowKind, workflowStepName, workflowSteps } from "./workflow-steps";

export { nextLiveIngestionReservationSql } from "./ingestion-reservation-repository";

export { persistReconciliationPayloadChunkStatement } from "./reconciliation-payload-repository";

export { streamedObjectMembers } from "./streamed-object-members";
export {
  catalogueEntityCollections,
  type CatalogueDraft,
  type CatalogueDraftEntity,
  type CatalogueEntityCollection,
} from "./catalogue-draft";
