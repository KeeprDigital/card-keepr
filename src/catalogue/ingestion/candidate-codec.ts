import { isCatalogueSourceCheck } from "../read";
import {
  AdministrationProblem,
  type CatalogueCandidate,
  type SupportedGame,
  catalogueCandidateContract,
  decodeDocument,
  StreamingSha256,
  utf8,
} from "../shared";

import type { RunRow } from "./run-types";
import { isRecord, parseSelectedGames } from "./run-values";

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
  if (obsoleteCandidateGames(row, parsed))
    throw new AdministrationProblem(
      409,
      "reconciliation_definition_changed",
      "This retained candidate predates Card categories. Collect and reconcile fresh evidence before approving a new whole candidate.",
    );
  return decodeCandidate(parsed);
}

/** Historical receipts expose their validated header, never invented current records. */
export function candidateGamesForInspection(row: RunRow): readonly SupportedGame[] {
  const parsed: unknown = JSON.parse(row.candidate_json);
  if (isRecord(parsed) && parsed.chunked_reconciliation_payload === "candidate")
    return parseSelectedGames(row.selected_games_json);
  return obsoleteCandidateGames(row, parsed) ?? decodeCandidate(parsed).selected_games;
}

function obsoleteCandidateGames(row: RunRow, value: unknown): readonly SupportedGame[] | undefined {
  if (
    !isRecord(value) ||
    value.contract !== catalogueCandidateContract ||
    !Array.isArray(value.cards) ||
    !Array.isArray(value.printings) ||
    !value.cards.every(isRecord) ||
    !value.printings.every(isRecord) ||
    !(
      value.cards.some(
        (card) =>
          card.category === undefined && card.gameplay_applicability === undefined && card.related_cards === undefined,
      ) || value.printings.some((printing) => printing.gameplay_applicability === undefined)
    )
  )
    return undefined;
  const games = decodeDocument<readonly SupportedGame[]>(
    "selectedGames",
    value.selected_games,
    "The persisted Catalogue Candidate header is invalid.",
  );
  if (!parseSelectedGames(row.selected_games_json).every((game) => games.includes(game)))
    throw new Error("The persisted Ingestion Run document is inconsistent.");
  const digest = new StreamingSha256();
  digest.update(utf8(row.candidate_json));
  if (digest.digestHex() !== row.candidate_digest)
    throw new Error("The persisted Catalogue Candidate digest does not match its retained bytes.");
  return games;
}

function decodeCandidate(input: unknown): CatalogueCandidate {
  const invalid = "The persisted Catalogue Candidate is invalid.";
  const value = decodeDocument<CatalogueCandidate>("candidate", input, invalid);
  const cardIds = new Set(value.cards.map((card) => card.id));
  if (
    value.cards.some(
      (card) =>
        card.game_data.profile !== `${card.game}@1` ||
        (card.official_identity.kind === "functional_designation" && card.game !== "one-piece") ||
        (card.official_identity.kind === "publisher_name" && card.game !== "riftbound"),
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
