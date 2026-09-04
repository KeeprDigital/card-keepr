// Public surface of the `reconciliation` cluster: turning retained evidence
// into a Catalogue Candidate, persisting it, and planning its publication,
// including the Product and Release side of the candidate.
// See ../README.md (issue #96).

export {
  reconcileRetainedCardPrintingEvidence,
  showReconciledPrinting,
} from "../card-printing-reconciliation";
export {
  reconcileDigimonCardAuthority,
  type DigimonCardAuthority,
} from "../digimon-reconciliation";
export {
  startOrObserveReconciliationWorkflow,
  type ReconciliationWorkflowParams,
} from "../reconciliation-workflow";
export {
  digestBoundCandidatePayload,
  failReconciliationWorkflow,
  retainedReconciliationResult,
} from "../reconciliation-candidate-store";
export {
  reconciliationPublication,
  type LocatorEvidence,
  type LocatorEvidenceCollection,
  type NormalizedLifecycle,
  type PublicationEvidenceResource,
  type ReconciliationPublicationPlan,
  type RelationshipEvidence,
} from "../reconciliation-publication";
export {
  parseReconciliationObservation,
  type ParsedReconciliationObservation,
  type ReconciliationWarning,
} from "../reconciliation-observation";
export {
  validateGundamListingCollectionGraph,
  type GundamListingCollectionGraphInput,
} from "../reconciliation-evidence";
export {
  erratumTargetLifecycleKey,
  exportErratum,
} from "../errata-rules-text";
export {
  distributionContextIdFor,
  productIdFor,
  reconcileProductReleaseCatalogue,
  type ProductReleaseEvidenceInput,
} from "../product-release-catalogue";
export {
  typedPrintingProjections,
  type PrintingDistributionContextProjection,
  type PrintingProductProjection,
} from "../product-release-projection";
export {
  productReleaseLifecyclePlan,
  productReleasePublicationStatements,
  type ProductRelationshipLifecycle,
  type ProductReleaseLifecyclePlan,
} from "../product-release-publication";
