import { isCatalogueSourceCheck } from "../read";
import { AdministrationProblem, type CatalogueCandidate, catalogueCandidateContract, decodeDocument } from "../shared";
import { FixtureInputError, fixtureCandidate } from "./fixture";

import type { RunRow, StartRunRequest } from "./run-types";
import { hasOnlyKeys, isRecord, parseSelectedGames } from "./run-values";

export async function validatedCatalogueCandidate(
  request: StartRunRequest,
): Promise<{ candidate: CatalogueCandidate; digest: string }> {
  return fixtureCandidate(request.fixture, request.selected_games).catch((error: unknown) => {
    if (error instanceof FixtureInputError) {
      throw new AdministrationProblem(422, error.code, error.message);
    }
    throw error;
  });
}

export function parseCandidate(row: RunRow): CatalogueCandidate {
  const parsed: unknown = JSON.parse(row.candidate_json);
  if (isRecord(parsed) && parsed.chunked_reconciliation_payload === "candidate") {
    return {
      contract: catalogueCandidateContract,
      selected_games: parseSelectedGames(row.selected_games_json),
      cards: [],
      printings: [],
    };
  }
  if (
    isRecord(parsed) &&
    hasOnlyKeys(parsed, ["fixture", "selected_games", "cards", "printings"]) &&
    parsed.fixture === "first-catalogue"
  ) {
    const upgraded = {
      contract: catalogueCandidateContract,
      selected_games: parsed.selected_games,
      cards: parsed.cards,
      printings: parsed.printings,
      legality_rules: [],
    };
    return decodeCandidate(upgraded);
  }
  return decodeCandidate(parsed);
}

function decodeCandidate(input: unknown): CatalogueCandidate {
  const invalid = "The persisted Catalogue Candidate is invalid.";
  const value = decodeDocument<CatalogueCandidate>("candidate", input, invalid);
  const cardIds = new Set(value.cards.map((card) => card.id));
  if (
    value.cards.some(
      (card) =>
        card.game_data.profile !== `${card.game}@1` ||
        (card.official_identity.kind === "functional_designation" && card.game !== "one-piece"),
    ) ||
    value.printings.some((printing) => !cardIds.has(printing.card_id)) ||
    value.source_checks?.some((check) => !isCatalogueSourceCheck(check))
  )
    throw new Error(invalid);
  for (const entity of [...value.cards, ...value.printings, ...(value.errata ?? [])]) {
    for (const provenance of entity.curated_provenance ?? []) {
      for (const evidence of provenance.evidence) {
        if (evidence.kind === "owner_reference") {
          try {
            if (new URL(evidence.uri).protocol.length <= 1) throw new Error(invalid);
          } catch {
            throw new Error(invalid);
          }
        }
      }
    }
  }
  return value;
}
