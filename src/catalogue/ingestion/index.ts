// Public surface of the `ingestion` cluster: Ingestion Run lifecycle and
// owner administration (approve, reject, retry, inspect, status), the
// fixture run, card-search repair, and the guarded Production Release.
// `AdministrationProblem` is deliberately not re-exported here: `shared`
// owns it, and the compatibility re-export on `ingestion.ts` goes with #98.
// See ../README.md (issue #96).

export {
  administrationStatus,
  approveRun,
  inspectCandidate,
  productionReleaseSmokeTargets,
  rejectRun,
  releaseSmokeSearchQuery,
  retryPublicationCleanup,
  retryRun,
  showRun,
  startFixtureRun,
  type ApproveRunRequest,
  type RejectRunRequest,
  type RetryPublicationCleanupRequest,
  type RetryRunRequest,
  type StartRunRequest,
} from "./ingestion";
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
