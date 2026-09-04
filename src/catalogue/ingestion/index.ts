// Public surface of the `ingestion` cluster: Ingestion Run lifecycle and
// owner administration (approve, reject, retry, inspect, status), the
// fixture run, card-search repair, and the guarded Production Release.
// `AdministrationProblem` is deliberately not re-exported here: `shared`
// owns it.
// See ../README.md (issue #96).

export {
  administrationStatus,
  inspectCandidate,
  productionReleaseSmokeTargets,
  releaseSmokeSearchQuery,
} from "./administration-inspection";
export { approveRun } from "./publication-lifecycle";
export { rejectRun, retryPublicationCleanup, retryRun, showRun, startFixtureRun } from "./run-lifecycle";
export type {
  ApproveRunRequest,
  RejectRunRequest,
  RetryPublicationCleanupRequest,
  RetryRunRequest,
  StartRunRequest,
} from "./run-types";
export {
  FixtureInputError,
  firstCatalogueFixture,
  firstFixtureCardId,
  firstFixturePrintingId,
  fixtureCandidate,
} from "./fixture";
export { runGuardedCardSearchRepair } from "./card-search-repair-administration";
export {
  prepareProductionRelease,
  type ProductionTarget,
} from "./production-release";

export { ingestionRoutes } from "./routes";

export type { PublicationBackupWaiter } from "./routes";
