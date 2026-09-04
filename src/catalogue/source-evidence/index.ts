// Public surface of the `source-evidence` cluster: Evidence Plans, Source
// Requests, Source Snapshot capture and parsing, the evidence repository,
// and collection pause and recovery classification.
// See ../README.md (issue #96).

export {
  extendRunRequestCapacity,
  reparseSourceSnapshot,
  retryEvidenceRun,
  showEvidenceRun,
  sourceObservationSetContent,
  sourceSnapshotContent,
  startEvidenceRun,
  type StartEvidenceRunRequest,
} from "./source-evidence";
export {
  collectSourceRequestBatch,
  collectionBatchSize,
  collectionBatchTimeBudgetMilliseconds,
  type SourceRequestBatchHalt,
  type SourceRequestBatchInput,
  type SourceRequestBatchOutcome,
} from "./source-evidence-batch";
export {
  advanceHostPacing,
  captureOperationIdentity,
  capturePreparedAttempt,
  hostPacingDelay,
  parseCapturedRequest,
  prepareCaptureAttempt,
  sourceHostPacingIntervalMilliseconds,
  sourceHostPacingMode,
  type CaptureTransportResult,
  type PreparedCaptureAttempt,
  type SourceHostPacingMode,
} from "./source-evidence-capture";
export {
  assertIdentifier,
  officialCollectionRequestsFromDiscovery,
  parseEvidencePlans,
  printingImageRetriesExhaustedFailureCode,
  requestFailureCode,
  terminalHttpFailureClass,
  toleratedPrintingImageFailureCodes,
  toleratesRequestFailure,
  transportPolicyForRole,
  type EvidenceHostWorkflowParams,
  type EvidenceParentWorkflowParams,
  type EvidencePlan,
  type EvidencePlanRequest,
  type OfficialSourceCollectionPlan,
  type SourceRequestFailureClass,
  type SourceRequestRole,
} from "./source-evidence-model";
// `startEvidenceRun` is the repository's function, re-exported above
// through `source-evidence.ts`.
export {
  RequestCapacityProblem,
  appendDiscoveredEvidenceRequests,
  collectionProgressFacts,
  currentCollectionWorkflowIds,
  evidencePlanForRequest,
  failActiveEvidenceRequestsForWorkflowExhaustion,
  finalizeEvidenceRun,
  pauseEvidenceRunForRequestCapacity,
  pauseEvidenceRunForWorkflowRecovery,
  pauseEvidenceRunOnOwnerRequest,
  pendingEvidenceRequestPage,
  pendingEvidenceRequests,
  persistOfficialSourceCollectionPlan,
  recordWorkflowIds,
  releaseTerminatedEvidenceRun,
  requiredEvidenceRun,
  resumePausedEvidenceRun,
  terminateEvidenceRun,
  workflowAttemptStatements,
  type EvidenceInspectionOptions,
  type EvidenceRequestRow,
  type IngestionEvidenceRow,
} from "./source-evidence-repository";
export {
  classifyCollectionProgress,
  classifyCollectionWorkflow,
  collectionBarrierSleepDuration,
  collectionStallGraceMilliseconds,
  isWorkflowInstanceNotFound,
  parentAttemptNumber,
  parentWorkflowAttemptId,
  safeWorkflowStatus,
  workflowAttemptRecord,
  type CollectionProgressFacts,
  type SafeWorkflowStatus,
  type WorkflowAttemptRecord,
  type WorkflowPauseReason,
} from "./collection-recovery";

export { pauseEvidenceCollection, resumeEvidenceRun, terminateEvidenceCollection } from "./evidence-administration";

export { sourceEvidenceRoutes, evidenceInspectionOptions } from "./routes";
