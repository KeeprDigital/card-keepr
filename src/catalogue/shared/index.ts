// Public surface of the `shared` cluster: leaf helpers and domain-type
// modules every other cluster may import. Nothing here imports another
// cluster. See ../README.md for the cluster map (issue #96).

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
  type LegalityRegion,
  type LegalityRule,
  type LegalityRuleEffect,
  type LegalityRuleSourceFieldPointers,
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
  type UnresolvedLegalityScope,
  type UnresolvedLegalityScopeDimension,
} from "./catalogue-candidate-types";
export { type CatalogueStore, catalogueStore, repositoryStatements } from "./catalogue-store-repository";
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
  maximumLegalityRuleRelationships,
  maximumLegalityStatusRules,
} from "./export-limits";
export {
  catalogueRevisionIdentity,
  evidenceRunIdentity,
  replayByDigest,
} from "./idempotent-identities";
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
} from "./reconciliation-payload";
// Game Profile contract helpers, consumed by legality, curated, export,
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
  validateMembershipPredicate,
} from "./reconciliation-profile";
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
