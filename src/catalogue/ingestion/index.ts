// Public surface of the `ingestion` cluster: Ingestion Run lifecycle and
// owner administration (approve, reject, retry, inspect, status), the
// prepared runs, card-search repair, and the guarded Production Release.
// `AdministrationProblem` is deliberately not re-exported here: `shared`
// owns it.
// See ../README.md (issue #96).

export {
  administrationStatus,
  inspectCandidate,
  productionReleaseSmokeTargets,
  releaseSmokeSearchQuery,
} from "./administration-inspection";
export { runGuardedCardSearchRepair } from "./card-search-repair-administration";
export {
  type ProductionTarget,
  prepareProductionRelease,
} from "./production-release";
export { approveRun } from "./publication-lifecycle";
export type { PublicationBackupWaiter } from "./routes";
export { ingestionRoutes } from "./routes";
export { rejectRun, retryPublicationCleanup, retryRun, showRun } from "./run-lifecycle";
export type {
  ApproveRunRequest,
  RejectRunRequest,
  RetryPublicationCleanupRequest,
  RetryRunRequest,
} from "./run-types";

export { advancePublicationExports, reservePublicExportAttempt } from "./publication-export-preparation";
