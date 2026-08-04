import type { CatalogueCard } from "./catalogue-candidate";
import { canonicalJson } from "./serialization";

type CardFacts = Omit<CatalogueCard, "id">;

export type DigimonCardAuthority = Readonly<{
  card: CardFacts;
  hasBaseRecord: boolean;
}>;

export function reconcileDigimonCardAuthority(
  current: DigimonCardAuthority,
  proposed: CardFacts,
  proposedIsBaseRecord: boolean,
):
  | Readonly<{ kind: "accepted"; authority: DigimonCardAuthority }>
  | Readonly<{ kind: "conflict"; detail: string }> {
  if (
    canonicalJson(rulesRelevantFacts(current.card)) !==
      canonicalJson(rulesRelevantFacts(proposed))
  ) {
    return {
      kind: "conflict",
      detail:
        "Retained Digimon Printings disagree on rules-relevant Card facts.",
    };
  }
  if (current.hasBaseRecord && proposedIsBaseRecord) {
    return current.card.name === proposed.name
      ? { kind: "accepted", authority: current }
      : {
          kind: "conflict",
          detail: "Retained Digimon base records disagree on the Card name.",
        };
  }
  if (current.hasBaseRecord) {
    return { kind: "accepted", authority: current };
  }
  if (proposedIsBaseRecord) {
    return {
      kind: "accepted",
      authority: { card: proposed, hasBaseRecord: true },
    };
  }
  return current.card.name === proposed.name
    ? {
        kind: "accepted",
        authority: { card: proposed, hasBaseRecord: false },
      }
    : {
        kind: "conflict",
        detail:
          "Digimon Printing records without a base record do not unanimously agree on the Card name.",
      };
}

function rulesRelevantFacts(card: CardFacts): unknown {
  return {
    game: card.game,
    official_identity: card.official_identity,
    effective_rules_text: card.effective_rules_text,
    game_data: card.game_data,
  };
}
