import { type CatalogueSourceCheck, type SupportedGame, type LegalityRegion, compareUtf8 } from "./shared";
import { registeredLegalitySourceScope } from "./source-adapters";

export type SourceFreshnessStorageRow = {
  game: string;
  area: string;
  source_lineage: string;
  region: string;
  checked_at: string;
};

export function sourceFreshnessFromStorage(row: SourceFreshnessStorageRow): CatalogueSourceCheck {
  const game = supportedGame(row.game);
  if (row.area === "legality-rules") {
    const region = legalityRegion(row.region);
    const scope = registeredLegalitySourceScope(row.source_lineage);
    if (scope.region !== region || scope.game !== game) {
      throw new Error("Stored Legality freshness scope is inconsistent.");
    }
    return {
      game,
      area: "legality-rules",
      source_lineage: row.source_lineage,
      region,
      checked_at: row.checked_at,
    };
  }
  if (
    !["cards-and-printings", "products-and-releases", "errata"].includes(row.area) ||
    row.source_lineage !== "" ||
    row.region !== ""
  ) {
    throw new Error("Stored Source freshness scope is invalid.");
  }
  return {
    game,
    area: row.area as Exclude<CatalogueSourceCheck["area"], "legality-rules">,
    checked_at: row.checked_at,
  };
}

export function sourceFreshnessStorageScope(freshness: CatalogueSourceCheck): {
  sourceLineage: string;
  region: string;
} {
  return freshness.area === "legality-rules"
    ? {
        sourceLineage: freshness.source_lineage,
        region: freshness.region,
      }
    : { sourceLineage: "", region: "" };
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
  const legality = check.area === "legality-rules";
  const expectedKeys = legality
    ? ["game", "area", "source_lineage", "region", "checked_at"]
    : ["game", "area", "checked_at"];
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
      source_lineage: legality && typeof check.source_lineage === "string" ? check.source_lineage : "",
      region: legality && typeof check.region === "string" ? check.region : "",
      checked_at: check.checked_at,
    });
    return true;
  } catch {
    return false;
  }
}

function supportedGame(value: string): SupportedGame {
  if (!["one-piece", "fusion-world", "digimon", "gundam"].includes(value)) {
    throw new Error("Stored Source freshness has an unsupported game.");
  }
  return value as SupportedGame;
}

function legalityRegion(value: string): LegalityRegion {
  if (!["EN-OCEANIA", "EN-ASIA", "EN-US"].includes(value)) {
    throw new Error("Stored Legality freshness has an unsupported region.");
  }
  return value as LegalityRegion;
}
