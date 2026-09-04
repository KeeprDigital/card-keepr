import { adapterReconciliationAreas, requiredSourceAdapter } from "../adapters";
import type { SourceFreshness } from "../export";
import {
  compareSourceFreshness,
  type SourceFreshnessStorageRow,
  sourceFreshnessFromStorage,
  sourceFreshnessKey,
  sourceFreshnessStorageScope,
} from "../read";
import type { CatalogueCandidate, CatalogueStore, SupportedGame } from "../shared";
import {
  publishedSourceFreshnessStatement,
  recordSourceFreshnessStatement,
  runObservationAdaptersStatement,
} from "./run-freshness-repository";

export async function freshnessStatementsForRun(
  database: CatalogueStore,
  games: readonly string[],
  runId: string,
  candidate: CatalogueCandidate,
  checkedAt: string,
): Promise<D1PreparedStatement[]> {
  return freshnessStatements(
    database,
    await checkedFreshnessAreasForRun(database, games, runId, candidate, checkedAt),
    runId,
  );
}

export async function checkedFreshnessAreasForRun(
  database: CatalogueStore,
  games: readonly string[],
  runId: string,
  candidate: CatalogueCandidate,
  checkedAt: string,
): Promise<SourceFreshness[]> {
  const coverage = await freshnessCoverage(database, runId, games);
  return [
    ...checkedFreshnessAreas([...coverage.catalogue], candidate, checkedAt),
    ...[...coverage.errata].map((game) => ({
      game,
      area: "errata" as const,
      checked_at: checkedAt,
    })),
  ];
}

function freshnessStatements(
  database: CatalogueStore,
  checks: readonly SourceFreshness[],
  runId: string,
): D1PreparedStatement[] {
  return checks.map((check) => {
    const scope = sourceFreshnessStorageScope(check);
    return recordSourceFreshnessStatement(database, {
      game: check.game,
      area: check.area,
      sourceLineage: scope.sourceLineage,
      region: scope.region,
      checkedAt: check.checked_at,
      runId: runId,
    });
  });
}

function checkedFreshnessAreas(
  games: readonly string[],
  candidate: CatalogueCandidate,
  checkedAt = "",
): SourceFreshness[] {
  const capturedChecks = candidate.source_checks ?? [];
  const generalChecks = games.flatMap((game) => {
    const supported = game as SupportedGame;
    const cardObservedGames = candidate.card_observed_games ?? candidate.selected_games;
    const capturedAt = (area: "cards-and-printings" | "products-and-releases") =>
      capturedChecks.find((check) => check.game === supported && check.area === area)?.checked_at ?? checkedAt;
    return [
      ...(cardObservedGames.includes(supported)
        ? [
            {
              game: supported,
              area: "cards-and-printings" as const,
              checked_at: capturedAt("cards-and-printings"),
            },
          ]
        : []),
      ...(candidate.product_observed_games?.includes(supported)
        ? [
            {
              game: supported,
              area: "products-and-releases" as const,
              checked_at: capturedAt("products-and-releases"),
            },
          ]
        : []),
    ];
  });
  const selectedGames = new Set(games);
  return [
    ...generalChecks,
    ...capturedChecks.filter(
      (
        check,
      ): check is Extract<
        SourceFreshness,
        {
          area: "legality-rules";
        }
      > => check.area === "legality-rules" && selectedGames.has(check.game),
    ),
  ];
}

async function freshnessCoverage(
  database: CatalogueStore,
  runId: string,
  games: readonly string[],
): Promise<
  Readonly<{
    catalogue: ReadonlySet<SupportedGame>;
    errata: ReadonlySet<SupportedGame>;
  }>
> {
  const observedAdapters = await runObservationAdaptersStatement(database, runId).all<{
    adapter_version: string;
    supported_game: SupportedGame;
  }>();
  const selectedGames = new Set(games as readonly SupportedGame[]);
  if (observedAdapters.results.length === 0) {
    return { catalogue: selectedGames, errata: new Set() };
  }
  const catalogue = new Set<SupportedGame>();
  const errata = new Set<SupportedGame>();
  for (const observed of observedAdapters.results) {
    if (!selectedGames.has(observed.supported_game)) continue;
    const areas = adapterReconciliationAreas(requiredSourceAdapter(observed.adapter_version));
    if (areas.includes("catalogue")) catalogue.add(observed.supported_game);
    if (areas.includes("errata")) errata.add(observed.supported_game);
  }
  return { catalogue, errata };
}

export async function sourceFreshnessForExport(
  database: CatalogueStore,
  catalogueGames: readonly SupportedGame[],
  refreshedChecks: readonly SourceFreshness[],
  publishedAt: string,
): Promise<SourceFreshness[]> {
  const prior = await publishedSourceFreshnessStatement(database).all<SourceFreshnessStorageRow>();
  const freshness = new Map<string, SourceFreshness>();
  for (const row of prior.results) {
    const check = sourceFreshnessFromStorage(row);
    if (catalogueGames.includes(check.game)) {
      freshness.set(sourceFreshnessKey(check), check);
    }
  }
  for (const check of refreshedChecks) {
    if (catalogueGames.includes(check.game)) {
      freshness.set(sourceFreshnessKey(check), {
        ...check,
        checked_at: check.checked_at.length === 0 ? publishedAt : check.checked_at,
      });
    }
  }
  return [...freshness.values()].sort(compareSourceFreshness);
}
