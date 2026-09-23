import { type CatalogueCard, canonicalJson } from "../shared";

type CardFacts = Omit<CatalogueCard, "id">;

/** Bandai is the owner-designated card-facts authority; Limitless is supplementary. */
export const onePieceCardFactsAuthority = "one-piece-en";

export type OnePieceCardAuthority = Readonly<{
  card: CardFacts;
  /** The retained facts came from the designated card-facts authority. */
  fromAuthority: boolean;
  /** The retained facts came from the Card's base locator rather than a reprint. */
  hasBaseRecord: boolean;
}>;

export type OnePieceCardStanding = Readonly<{ fromAuthority: boolean; isBaseRecord: boolean }>;

export type OnePieceAuthorityResolution = Readonly<{
  authority: OnePieceCardAuthority;
  /** Set when the two observations disagreed; the published facts are the authority's. */
  superseded: Readonly<{
    reason: "supplementary_source" | "reprint" | "equal_standing";
    /** A difference the Publisher's own wording carries, rather than spacing. */
    material: boolean;
    fields: readonly string[];
  }> | null;
}>;

/** Resolve two retained observations of one One Piece Card (issue #334).
 *
 * Bandai wins every Card-level field over Limitless, and within Bandai the base
 * locator's text is preferred over a reprint's. A disagreement is recorded for
 * review rather than blocking the candidate: the supplementary or reprinted
 * value stays retained Source Observation evidence and is not published.
 */
export function reconcileOnePieceCardAuthority(
  current: OnePieceCardAuthority,
  proposed: CardFacts,
  standing: OnePieceCardStanding,
): OnePieceAuthorityResolution {
  const proposedAuthority: OnePieceCardAuthority = {
    card: proposed,
    fromAuthority: standing.fromAuthority,
    hasBaseRecord: standing.isBaseRecord,
  };
  const differing = differingFields(current.card, proposed);
  if (differing.length === 0) {
    // Equal facts: keep the better-standing record so later comparisons use it.
    return { authority: preferred(current, proposedAuthority), superseded: null };
  }
  const reason =
    current.fromAuthority !== standing.fromAuthority
      ? "supplementary_source"
      : current.hasBaseRecord !== standing.isBaseRecord
        ? "reprint"
        : "equal_standing";
  return {
    authority: preferred(current, proposedAuthority),
    superseded: {
      reason,
      material: differing.some((field) => isMaterial(current.card, proposed, field)),
      fields: differing,
    },
  };
}

/** The authority outranks a supplementary source; a base record outranks a reprint. */
function preferred(current: OnePieceCardAuthority, proposed: OnePieceCardAuthority): OnePieceCardAuthority {
  if (current.fromAuthority !== proposed.fromAuthority) return current.fromAuthority ? current : proposed;
  if (current.hasBaseRecord !== proposed.hasBaseRecord) return current.hasBaseRecord ? current : proposed;
  return current;
}

function comparable(card: CardFacts): Record<string, unknown> {
  const { related_cards: _related, ...rest } = card as CardFacts & { related_cards?: unknown };
  const { attributes, ...gameData } = rest.game_data;
  return {
    ...rest,
    game_data: gameData,
    ...Object.fromEntries(Object.entries(attributes).map(([key, value]) => [`attributes.${key}`, value])),
  };
}

function differingFields(current: CardFacts, proposed: CardFacts): string[] {
  const left = comparable(current);
  const right = comparable(proposed);
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((field) => canonicalJson(left[field] ?? null) !== canonicalJson(right[field] ?? null))
    .sort();
}

/** A difference that survives collapsing whitespace is the Publisher's wording. */
function isMaterial(current: CardFacts, proposed: CardFacts, field: string): boolean {
  const left = comparable(current)[field];
  const right = comparable(proposed)[field];
  if (typeof left !== "string" || typeof right !== "string") return true;
  return left.replaceAll(/\s+/gu, "") !== right.replaceAll(/\s+/gu, "");
}
