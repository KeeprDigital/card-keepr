import {
  startEvidenceRun,
  type StartEvidenceRunRequest,
} from "../../../src/catalogue/source-evidence";

export function injectFixtureEvidencePlan(
  database: D1Database,
  request: StartEvidenceRunRequest,
): Promise<Record<string, unknown>> {
  return startEvidenceRun(database, request, "synthetic_fixture");
}
