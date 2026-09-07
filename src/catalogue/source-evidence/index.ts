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
export {
  advanceHostPacing,
  type CaptureTransportResult,
  captureOperationIdentity,
  capturePreparedAttempt,
  hostPacingDelay,
  type PreparedCaptureAttempt,
  parseCapturedRequest,
  prepareCaptureAttempt,
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

export { assertSelectedAuthoritiesCollected, sourceAuthorities } from "./source-authority";

export {
  beginEvidenceCleanup,
  inspectEvidenceCleanup,
  advanceEvidenceCleanup,
  inspectEvidenceCleanupResults,
  resumeEvidenceCleanup,
} from "./evidence-cleanup";

export { beginStagingCleanup, advanceStagingCleanup } from "./staging-cleanup";
export { retainEvidenceObjectReferenceStatement } from "./evidence-cleanup-repository";
