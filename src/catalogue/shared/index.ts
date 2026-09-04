// Public surface of the `shared` cluster: leaf helpers and domain-type
// modules every other cluster may import. Nothing here imports another
// cluster. See ../README.md for the cluster map (issue #96).

export {
  canonicalJson,
  canonicalNdjson,
  compareUtf8,
  sha256,
  sha256Text,
  utf8,
} from "./serialization";
export {
  deterministicGzip,
  deterministicGzipStream,
} from "./export-compression";
export { isIsoCalendarDate } from "./calendar-date";
export { StreamingSha256 } from "./streaming-sha256";
export {
  catalogueRevisionIdentity,
  evidenceRunIdentity,
  replayByDigest,
} from "./idempotent-identities";
export { AdministrationProblem } from "./administration-problem";
export { operationalDiagnostics } from "./operational-diagnostics";
export { SPINE_REVISION_ID } from "./spine-revision.mjs";

// The Catalogue Candidate's shape (the leaf types from issue #90).
export {
  catalogueCandidateContract,
  type CatalogueCandidate,
  type CatalogueCard,
  type CatalogueDistributionContext,
  type CatalogueErratum,
  type CataloguePrinting,
  type CataloguePrintingImage,
  type CatalogueProduct,
  type CatalogueRelease,
  type CatalogueSourceCheck,
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
export type {
  CuratedEvidence,
  CuratedFieldTarget,
  CuratedProvenance,
  CuratedProvenanceBearing,
  CuratedRelationshipTarget,
} from "./curated-provenance";

// Game Profile contract helpers, consumed by legality, curated, export,
// and reconciliation alike.
export {
  canonicalProfileAttributes,
  exportedGameProfileSchema,
  rawSourceValue,
  requiredProfileContract,
  sourceFieldWarning,
  sourceVocabularyWarning,
  validateMembershipPredicate,
  type ProfileWarning,
} from "./reconciliation-profile";

// D1 payload chunking and the guarded atomic batch, consumed by every
// cluster that writes publication statements.
export {
  byteBoundedJsonArrays,
  chunkedPayloadMarker,
  guardedAtomicBatch,
  payloadChunkStatements,
  retainedPayload,
} from "./reconciliation-payload";

export {
  CatalogueExportLimitError,
  maximumCatalogueExportBytes,
  maximumCatalogueExportObjectBytes,
  maximumExportComponentBytes,
  maximumExportRecordBytes,
  maximumLegalityRuleRelationships,
  maximumLegalityStatusRules,
} from "./export-limits";

export { decodeDocument, type DocumentSchema } from "./document-decoder";

export { activeRunStages } from "./ingestion-run-stages";
