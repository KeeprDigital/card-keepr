import { sourceLineages } from "../adapters";
import { AdministrationProblem, type CatalogueStore, canonicalJson } from "../shared";
import { sourceAuthorities } from "./source-authority";
import {
  type SourceLifecycleDecision,
  sourceLifecycleHistoryStatement,
  sourceLifecycleReplayStatement,
  sourceAuthorityDecisionCountStatement,
  insertSourceLifecycleDecisionStatement,
} from "./source-lifecycle-repository";

export async function sourceLifecycleHistory(database: CatalogueStore, lineage: string) {
  assertLineage(lineage);
  const history = (await sourceLifecycleHistoryStatement(database, lineage).all<SourceLifecycleDecision>()).results;
  return {
    source_lineage: lineage,
    state: history[0]?.state ?? "active",
    generation: history[0]?.generation ?? 0,
    history: history.map(publicDecision),
  };
}
export async function decideSourceLifecycle(
  database: CatalogueStore,
  lineage: string,
  input: {
    state: string;
    expected_generation: string;
    rationale: string;
    idempotency_key: string;
  },
  observedAt: string,
) {
  assertLineage(lineage);
  const generation = Number(input.expected_generation);
  if (
    !/^\d+$/u.test(input.expected_generation) ||
    !Number.isSafeInteger(generation) ||
    generation >= Number.MAX_SAFE_INTEGER ||
    (input.state !== "retired" && input.state !== "active")
  ) {
    throw new AdministrationProblem(
      422,
      "source_lifecycle_invalid",
      "Select active or retired and a non-negative expected generation.",
    );
  }
  const requestJson = canonicalJson({ source_lineage: lineage, ...input });
  const replay = await sourceLifecycleReplayStatement(database, input.idempotency_key).first<SourceLifecycleDecision>();
  if (replay) return replayDecision(replay, requestJson);
  // The count is compared inside the write transaction so a concurrent authority
  // decision cannot invalidate the absence checked below.
  const count = await sourceAuthorityDecisionCountStatement(database).first<{ count: number }>();
  const { authorities } = await sourceAuthorities(database);
  if (input.state === "retired" && authorities.some((authority) => authority.source_lineage === lineage)) {
    throw new AdministrationProblem(
      409,
      "source_is_authority",
      "Explicitly revise every applicable Source Authority designation before retiring this Source. Retirement does not transfer authority.",
    );
  }
  const decision: SourceLifecycleDecision = {
    idempotency_key: input.idempotency_key,
    source_lineage: lineage,
    state: input.state,
    generation: generation + 1,
    rationale: input.rationale,
    request_json: requestJson,
    decided_at: observedAt,
  };
  try {
    await insertSourceLifecycleDecisionStatement(database, decision, count!.count).run();
  } catch (error) {
    const raced = await sourceLifecycleReplayStatement(
      database,
      input.idempotency_key,
    ).first<SourceLifecycleDecision>();
    if (raced) return replayDecision(raced, requestJson);
    if (error instanceof Error && /source_lifecycle_|UNIQUE constraint/u.test(error.message))
      throw new AdministrationProblem(
        409,
        "source_lifecycle_conflict",
        "Inspect the current generation and wait for collection, recovery and release operations to be idle; then revise the lifecycle decision explicitly.",
      );
    throw error;
  }
  return publicDecision(decision);
}
function assertLineage(lineage: string) {
  if (!sourceLineages.some(({ id }) => id === lineage))
    throw new AdministrationProblem(422, "source_lineage_invalid", "Select a registered Source Lineage.");
}
function replayDecision(decision: SourceLifecycleDecision, requestJson: string) {
  if (decision.request_json !== requestJson)
    throw new AdministrationProblem(
      409,
      "idempotency_key_reused",
      "The lifecycle decision key belongs to a different request.",
    );
  return publicDecision(decision);
}
function publicDecision({ request_json: _request, ...decision }: SourceLifecycleDecision) {
  return decision;
}
