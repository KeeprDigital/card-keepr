import { canonicalJson, type CatalogueStore } from "../shared";
import { synchronizeGameCandidatePauseStatement } from "./game-candidate-repository";
import { failGamePreparationStatement, releaseGamePreparationSlotStatement } from "./game-reconciliation-repository";
import { reconciliationOperationHeaderStatement } from "./reconciliation-progress-repository";

/** The caller supplies the generation-fenced store. Collection provenance is never a terminal mutation target. */
export async function failIndependentGamePreparation(
  database: CatalogueStore,
  preparationId: string,
  code: string,
  diagnostics: readonly Record<string, unknown>[],
  preparedStatements: D1PreparedStatement[] = [],
): Promise<Record<string, unknown> | null> {
  const operation = await reconciliationOperationHeaderStatement(database, preparationId).first<{
    supported_game: string | null;
    ingestion_run_id: string;
    state: string;
    terminal_result_json: string | null;
  }>();
  if (!operation?.supported_game) return null;
  if (operation.terminal_result_json) return JSON.parse(operation.terminal_result_json);
  if (operation.state !== "preparing")
    return {
      preparation_id: preparationId,
      run_id: operation.ingestion_run_id,
      state: operation.state,
      publishable: false,
    };
  const summary: Record<string, unknown>[] = [];
  let bytes = 0;
  for (const diagnostic of diagnostics) {
    const compact = { code: String(diagnostic.code).slice(0, 256), detail: String(diagnostic.detail).slice(0, 1024) };
    const size = new TextEncoder().encode(canonicalJson(compact)).byteLength;
    if (summary.length === 100 || bytes + size > 40000) break;
    summary.push(compact);
    bytes += size + 1;
  }
  const result = {
    contract: "card-keepr-game-reconciliation-outcome@1",
    preparation_id: preparationId,
    run_id: operation.ingestion_run_id,
    state: "failed",
    publishable: false,
    failure_code: code,
    diagnostics: summary,
    diagnostics_truncated:
      summary.length !== diagnostics.length || diagnostics.some((entry) => String(entry.detail).length > 1024),
  };
  await database.batch([
    ...preparedStatements,
    failGamePreparationStatement(database, preparationId, code, canonicalJson(result)),
    synchronizeGameCandidatePauseStatement(database, preparationId),
    releaseGamePreparationSlotStatement(database, preparationId),
  ]);
  return result;
}

export type NativeOperationResult = {
  supported_game: string | null;
  ingestion_run_id: string;
  state: string;
  generation: number;
  terminal_result_json: string | null;
  candidate_digest: string | null;
};

/** A superseded worker may observe current status but cannot claim a later generation's outcome. */
export function independentGamePreparationResult(
  preparationId: string,
  operation: NativeOperationResult | null,
  generation: number,
): Record<string, unknown> | null {
  if (!operation?.supported_game) return null;
  const identity = { preparation_id: preparationId, run_id: operation.ingestion_run_id };
  if (operation.generation !== generation) return { ...identity, state: "superseded", publishable: false };
  if (operation.state === "preparing") return null;
  if (operation.terminal_result_json) return JSON.parse(operation.terminal_result_json);
  return {
    ...identity,
    state: operation.state,
    publishable: operation.state === "sealed",
    ...(operation.state === "sealed" ? { candidate_digest: operation.candidate_digest } : {}),
  };
}

export type NativePreparationGuardState = NativeOperationResult & {
  deadline: string;
  expected_game_revision_id: string;
  current_game_revision_id: string | null;
};

export function nativePreparationFailureCode(operation: NativePreparationGuardState): string | null {
  if (Date.parse(operation.deadline) <= Date.now()) return "reconciliation_deadline_expired";
  if (operation.expected_game_revision_id !== operation.current_game_revision_id) return "game_revision_mismatch";
  return null;
}
