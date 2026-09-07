import { type CatalogueSourceCheck, type SupportedGame, compareUtf8 } from "../shared";

export type SourceFreshnessStorageRow = {
  game: string;
  area: string;
  source_lineage: string;
  region: string;
  checked_at: string;
};

export function sourceFreshnessFromStorage(row: SourceFreshnessStorageRow): CatalogueSourceCheck {
  const game = supportedGame(row.game);
  if (
    !["cards-and-printings", "products-and-releases", "errata"].includes(row.area) ||
    row.source_lineage !== "" ||
    row.region !== ""
  ) {
    throw new Error("Stored Source freshness scope is invalid.");
  }
  return {
    game,
    area: row.area as CatalogueSourceCheck["area"],
    checked_at: row.checked_at,
  };
}

export function sourceFreshnessStorageScope(freshness: CatalogueSourceCheck): {
  sourceLineage: string;
  region: string;
} {
  return { sourceLineage: "", region: "" };
}

export function sourceFreshnessKey(freshness: CatalogueSourceCheck): string {
  const scope = sourceFreshnessStorageScope(freshness);
  return [freshness.game, freshness.area, scope.sourceLineage, scope.region].join(":");
}

export function compareSourceFreshness(left: CatalogueSourceCheck, right: CatalogueSourceCheck): number {
  return compareUtf8(sourceFreshnessKey(left), sourceFreshnessKey(right));
}

export function isCatalogueSourceCheck(value: unknown): value is CatalogueSourceCheck {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const check = value as Record<string, unknown>;
  const expectedKeys = ["game", "area", "checked_at"];
  if (
    Object.keys(check).length !== expectedKeys.length ||
    expectedKeys.some((key) => !(key in check)) ||
    typeof check.game !== "string" ||
    typeof check.area !== "string" ||
    typeof check.checked_at !== "string" ||
    check.checked_at.length === 0
  ) {
    return false;
  }
  try {
    sourceFreshnessFromStorage({
      game: check.game,
      area: check.area,
      source_lineage: "",
      region: "",
      checked_at: check.checked_at,
    });
    return true;
  } catch {
    return false;
  }
}

function supportedGame(value: string): SupportedGame {
  if (!["one-piece", "fusion-world", "digimon", "gundam", "riftbound"].includes(value)) {
    throw new Error("Stored Source freshness has an unsupported game.");
  }
  return value as SupportedGame;
}
