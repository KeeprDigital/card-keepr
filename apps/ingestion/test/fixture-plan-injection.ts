import {
  startEvidenceRun,
  type StartEvidenceRunRequest,
} from "../../../src/catalogue/source-evidence";
import {
  startFixtureRun,
  type StartRunRequest,
} from "../../../src/catalogue/ingestion";

export function injectFixtureEvidencePlan(
  database: D1Database,
  request: StartEvidenceRunRequest,
): Promise<Record<string, unknown>> {
  return startEvidenceRun(database, request, "synthetic_fixture");
}

export function injectFixturePublication(
  database: D1Database,
  catalogueExports: R2Bucket,
  request: StartRunRequest,
  observedAt?: string,
): Promise<Record<string, unknown>> {
  return startFixtureRun(
    database,
    catalogueExports,
    request,
    observedAt,
  );
}
