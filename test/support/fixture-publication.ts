import { seedRunFixtureStatement } from "../../apps/ingestion/test/query-helpers/run-events";
import { retryRun } from "../../src/catalogue/ingestion";
import { replayAdministration } from "../../src/catalogue/ingestion/administration-idempotency";
import { AdministrationProblem, canonicalJson, catalogueStore, sha256Text } from "../../src/catalogue/shared";
import { FixtureInputError, fixtureCandidate } from "./catalogue-fixture";

export type FixturePublicationRequest = {
  fixture: string;
  selected_games: readonly string[];
  idempotency_key: string;
  operational_request_id?: string;
};

export async function fixturePublicationSourceId(request: FixturePublicationRequest): Promise<string> {
  return `fixture-source_${await sha256Text(canonicalJson(request))}`;
}

/** Seed retained candidate facts, then exercise the ordinary retry command to
 * prepare an approvable run with all Curated, lock, and idempotency checks. */
export async function injectFixturePublication(
  database: D1Database,
  catalogueExports: R2Bucket,
  request: FixturePublicationRequest,
  observedAt = new Date().toISOString(),
): Promise<Record<string, unknown>> {
  const store = catalogueStore(database);
  const sourceId = await fixturePublicationSourceId(request);
  const replay = await replayAdministration(
    store,
    request.idempotency_key,
    "retry_ingestion_run",
    canonicalJson({ source_run_id: sourceId }),
  );
  if (replay !== null) return replay;
  const existing = await fixturePublicationSourceStatement(database, sourceId).first();
  if (existing === null) {
    const { candidate } = await fixtureCandidate(request.fixture, request.selected_games).catch((error: unknown) => {
      if (error instanceof FixtureInputError) throw new AdministrationProblem(422, error.code, error.message);
      throw error;
    });
    await seedRunFixtureStatement(database, {
      id: sourceId,
      state: "failed",
      started_at: "2000-01-01T00:00:00.000Z",
      terminal_at: "2000-01-01T00:00:00.000Z",
      selected_games_json: JSON.stringify(request.selected_games),
      candidate_json: canonicalJson(candidate),
      failure_code: "fixture_source_ready",
    }).run();
  }
  return retryRun(store, catalogueExports, sourceId, request, observedAt);
}

function fixturePublicationSourceStatement(database: D1Database, runId: string): D1PreparedStatement {
  return database.prepare("SELECT id FROM ingestion_runs WHERE id = ?").bind(runId);
}
