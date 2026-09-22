// Public surface of the `source-evidence` cluster: Evidence Plans, Source
// Requests, Source Snapshot capture and parsing, the evidence repository,
// and collection pause and recovery classification.
// See ../README.md (issue #96).

export {
  type CollectionProgressFacts,
  classifyCollectionProgress,
  classifyCollectionWorkflow,
  collectionBarrierSleepDuration,
  collectionStallGraceMilliseconds,
  parentAttemptNumber,
  parentWorkflowAttemptId,
  type SafeWorkflowStatus,
  safeWorkflowStatus,
  type WorkflowAttemptRecord,
  type WorkflowPauseReason,
  workflowAttemptRecord,
} from "./collection-recovery";
export { pauseEvidenceCollection, resumeEvidenceRun, terminateEvidenceCollection } from "./evidence-administration";
export type { IngestionEvidenceRow } from "./ingestion-run-repository";
export { evidenceInspectionOptions, sourceEvidenceRoutes } from "./routes";
export {
  extendRunRequestCapacity,
  pendingEvidenceHostShards,
  reparseSourceSnapshot,
  retryEvidenceRun,
  type StartEvidenceRunRequest,
  showEvidenceRun,
  sourceObservationSetContent,
  sourceSnapshotContent,
  startEvidenceRun,
} from "./source-evidence";
export {
  collectionBatchSize,
  collectionBatchTimeBudgetMilliseconds,
  collectSourceRequestBatch,
  type SourceRequestBatchHalt,
  type SourceRequestBatchInput,
  type SourceRequestBatchOutcome,
} from "./source-evidence-batch";
export { HostPacer } from "./host-pacer";
export {
  adaptHostPacing,
  currentHostPacingState,
  hostPacingRecoveryStreak,
  type HostPacingDecision,
  type HostPacingEvent,
  type HostPacingSignal,
  type HostPacingState,
  type ResolvedHostPacingPolicy,
  resolveHostPacingPolicy,
} from "./host-pacing";
export {
  type CaptureTransportResult,
  captureOperationIdentity,
  capturePreparedAttempt,
  type PreparedCaptureAttempt,
  parseCapturedRequest,
  prepareCaptureAttempt,
  settleTerminalOwnerDispatches,
  type SourceHostPacingMode,
  sourceHostPacingIntervalMilliseconds,
  sourceHostPacingMode,
} from "./source-evidence-capture";
export {
  assertIdentifier,
  type EvidenceHostWorkflowParams,
  type EvidenceParentWorkflowParams,
  isOptionalSourceOutage,
  type EvidencePlan,
  type EvidencePlanRequest,
  type OfficialSourceCollectionPlan,
  officialCollectionRequestsFromDiscovery,
  parseEvidencePlans,
  printingImageRetriesExhaustedFailureCode,
  requestFailureCode,
  type SourceRequestFailureClass,
  type SourceRequestRole,
  terminalHttpFailureClass,
  toleratedPrintingImageFailureCodes,
  toleratesRequestFailure,
  redirectDiscoveredFailureCode,
  redirectDiscoveryRoles,
  registrableDomain,
  sameSiteRedirectTarget,
  transportPolicyForRole,
} from "./source-evidence-model";
// `startEvidenceRun` is the repository's function, re-exported above
// through `source-evidence.ts`.
export {
  appendDiscoveredEvidenceRequests,
  collectionProgressFacts,
  currentCollectionWorkflowIds,
  type EvidenceInspectionOptions,
  type EvidenceRequestRow,
  evidencePlanForRequest,
  failActiveEvidenceRequestsForWorkflowExhaustion,
  finalizeEvidenceRun,
  isCurrentCollectionWorkflowAttempt,
  pauseEvidenceRunForRequestCapacity,
  pauseEvidenceRunForWorkflowRecovery,
  pauseEvidenceRunOnOwnerRequest,
  pendingEvidenceRequestPage,
  evidenceHostShardRequestCapacity,
  pendingEvidenceRequests,
  persistOfficialSourceCollectionPlan,
  RequestCapacityProblem,
  recordWorkflowIds,
  releaseTerminatedEvidenceRun,
  requiredEvidenceRun,
  resumePausedEvidenceRun,
  terminateEvidenceRun,
  workflowAttemptStatements,
} from "./source-evidence-repository";

export { recordIngestionWorkflowProgress } from "./workflow-progress";

export { retainedSourceEvidenceGuardStatement } from "./source-plan-repository";

export { assertSelectedAuthoritiesCollected, missingSelectedAuthorities, sourceAuthorities } from "./source-authority";

export {
  beginEvidenceCleanup,
  inspectEvidenceCleanup,
  advanceEvidenceCleanup,
  inspectEvidenceCleanupResults,
  resumeEvidenceCleanup,
  pauseEvidenceCleanup,
} from "./evidence-cleanup";

export { beginStagingCleanup, advanceStagingCleanup } from "./staging-cleanup";
export { retainEvidenceObjectReferenceStatement } from "./evidence-cleanup-repository";

export { sealedSourceRecordProgress, sourceRecordInitialDigest, sourceRecordNextDigest } from "./source-record-intake";
export { sourceRecordAt, sourceRecordPage, type SourceRecordRow } from "./source-record-repository";

export { restoreSourceRecordText, type SourceRecordEnvelope } from "./source-record-text";

export { readSourceRecordManifest } from "./source-record-manifest";

export { cleanupSchema, captureCleanupRoute, stagingCleanupRoute, retryCleanupRoute } from "./cleanup-http-contract";

export { operationalDiagnosticsSchema, evidenceStatusSchema } from "./http-evidence-schema";
