import { sourceLineages, requiredSourceAdapter, adapterReconciliationAreas } from "../adapters";
import { AdministrationProblem, type CatalogueStore, canonicalJson } from "../shared";
import {
  type AuthorityDecision,
  authorityDecisionsStatement,
  authorityReplayStatement,
  insertAuthorityDecisionStatement,
} from "./source-authority-repository";

export type AuthoritySelectionRequest = {
  game: string;
  locale: string;
  release_region: string;
  area: string;
  source_lineage: string;
  expected_generation: string;
  rationale: string;
  idempotency_key: string;
};
// Deliberate initial designations, independent of ownership and source naming.
// Adding another publisher source does not change this policy.
const initialAuthorityLineages = ["one-piece-en", "fusion-world-en", "digimon-en", "gundam-en-asia", "gundam-en-us"];
const areas = ["card_facts", "printing_details", "corrected_card_content"] as const;
export async function sourceAuthorities(database: CatalogueStore) {
  const decisions = (await authorityDecisionsStatement(database).all<AuthorityDecision>()).results;
  return {
    authorities: sourceLineages
      .filter(({ id }) => initialAuthorityLineages.includes(id))
      .flatMap((lineage) =>
        areas.map((area) => {
          const selected = decisions.find(
            (decision) =>
              decision.game === lineage.game &&
              decision.locale === lineage.locale &&
              decision.release_region === lineage.release_region &&
              decision.area === area,
          );
          return selected
            ? publicDecision(selected)
            : {
                game: lineage.game,
                locale: lineage.locale,
                release_region: lineage.release_region,
                area,
                source_lineage: lineage.id,
                generation: 0,
                rationale: "Initial publisher source designation",
                decided_at: null,
              };
        }),
      ),
  };
}

export async function selectSourceAuthority(
  database: CatalogueStore,
  input: AuthoritySelectionRequest,
  observedAt: string,
) {
  const generation = Number(input.expected_generation);
  const area = areas.find((area) => area === input.area);
  const lineage = sourceLineages.find(({ id }) => id === input.source_lineage);
  if (
    !/^\d+$/u.test(input.expected_generation ?? "") ||
    !Number.isSafeInteger(generation) ||
    generation >= Number.MAX_SAFE_INTEGER ||
    area === undefined ||
    !lineage ||
    lineage.game !== input.game ||
    lineage.locale !== input.locale ||
    lineage.release_region !== input.release_region
  ) {
    throw new AdministrationProblem(
      422,
      "source_authority_scope_invalid",
      "Select a registered Source Lineage in the exact game, English locale and release region, a card-content area, and a non-negative expected generation.",
    );
  }
  const requestJson = canonicalJson(input);
  const replay = await authorityReplayStatement(database, input.idempotency_key).first<AuthorityDecision>();
  if (replay) return replayDecision(replay, requestJson);
  const decision: AuthorityDecision = {
    idempotency_key: input.idempotency_key,
    game: lineage.game,
    locale: lineage.locale,
    release_region: lineage.release_region,
    area,
    source_lineage: lineage.id,
    generation: generation + 1,
    rationale: input.rationale,
    request_json: requestJson,
    decided_at: observedAt,
  };
  try {
    await insertAuthorityDecisionStatement(database, decision).run();
  } catch (error) {
    const raced = await authorityReplayStatement(database, input.idempotency_key).first<AuthorityDecision>();
    if (raced) return replayDecision(raced, requestJson);
    const message = error instanceof Error ? error.message : "";
    if (/source_authority_(?:generation_mismatch|operation_not_idle)|UNIQUE constraint/u.test(message)) {
      throw new AdministrationProblem(
        409,
        "source_authority_conflict",
        "Authority was not changed. Inspect the current generation and wait for collection, recovery and release operations to be idle.",
      );
    }
    throw error;
  }
  return publicDecision(decision);
}
function replayDecision(decision: AuthorityDecision, requestJson: string) {
  if (decision.request_json !== requestJson)
    throw new AdministrationProblem(
      409,
      "idempotency_key_reused",
      "The authority decision key was already used with a different request.",
    );
  return publicDecision(decision);
}
function publicDecision({ request_json: _request, idempotency_key: _key, ...decision }: AuthorityDecision) {
  return decision;
}

/** Until source-scoped carry-forward is implemented, a refresh cannot silently
 * substitute another source for an explicitly selected authority in its scope.
 * Acquisition remains permitted so contradictory evidence can still be retained. */
export async function assertSelectedAuthoritiesCollected(
  database: CatalogueStore,
  plans: readonly {
    supported_game: string;
    source_lineage: string;
    adapter_version: string;
  }[],
) {
  const { authorities } = await sourceAuthorities(database);
  for (const decision of authorities) {
    const area = decision.area === "corrected_card_content" ? "errata" : "catalogue";
    const applicable = plans.filter((plan) => {
      const lineage = sourceLineages.find(({ id }) => id === plan.source_lineage);
      return (
        plan.supported_game === decision.game &&
        lineage?.locale === decision.locale &&
        lineage.release_region === decision.release_region &&
        adapterReconciliationAreas(requiredSourceAdapter(plan.adapter_version)).includes(area)
      );
    });
    if (applicable.length > 0 && !applicable.some((plan) => plan.source_lineage === decision.source_lineage)) {
      throw new Error(
        `Selected Source Authority ${decision.source_lineage} for ${decision.area} (${decision.locale}/${decision.release_region}) is absent. Collect the selected source or explicitly change authority; no fallback is permitted.`,
      );
    }
  }
}
