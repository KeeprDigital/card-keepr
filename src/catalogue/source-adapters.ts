import { AdministrationProblem } from "./ingestion";

export type SourceAdapterRegistration = Readonly<{
  adapterVersion: string;
  sourceLineage: string;
  supportedGame: string;
  gameProfileVersion: string;
  parserContract: string;
  maximumJsonBytes: number;
  origin: "production" | "synthetic_fixture";
  reconciliationCoverage: "synthetic_fixture" | "unavailable";
  parse: (document: unknown) => readonly unknown[];
}>;

const parseCardDocument = (document: unknown): readonly unknown[] => {
  if (
    typeof document === "object" &&
    document !== null &&
    !Array.isArray(document) &&
    Array.isArray((document as { cards?: unknown }).cards)
  ) {
    return (document as { cards: unknown[] }).cards;
  }
  return [document];
};

export const sourceAdapterRegistrations: readonly SourceAdapterRegistration[] =
  Object.freeze(
    [
      {
        adapterVersion: "one-piece-json-document@1",
        sourceLineage: "one-piece-en",
        supportedGame: "one-piece",
        gameProfileVersion: "one-piece@1",
        parserContract: "one-piece-card-document@1",
        maximumJsonBytes: 1024 * 1024,
        origin: "production" as const,
        reconciliationCoverage: "unavailable" as const,
        parse: parseCardDocument,
      },
      {
        adapterVersion: "one-piece-json-document@2",
        sourceLineage: "one-piece-en",
        supportedGame: "one-piece",
        gameProfileVersion: "one-piece@1",
        parserContract: "one-piece-card-document@1",
        maximumJsonBytes: 1024 * 1024,
        origin: "production" as const,
        reconciliationCoverage: "unavailable" as const,
        parse: parseCardDocument,
      },
      {
        adapterVersion: "fusion-world-en@1",
        sourceLineage: "fusion-world-en",
        supportedGame: "fusion-world",
        gameProfileVersion: "fusion-world@1",
        parserContract: "fusion-world-card-document@1",
        maximumJsonBytes: 1024 * 1024,
        origin: "production" as const,
        reconciliationCoverage: "unavailable" as const,
        parse: parseCardDocument,
      },
      {
        adapterVersion: "digimon-en@1",
        sourceLineage: "digimon-en",
        supportedGame: "digimon",
        gameProfileVersion: "digimon@1",
        parserContract: "digimon-card-document@1",
        maximumJsonBytes: 1024 * 1024,
        origin: "production" as const,
        reconciliationCoverage: "unavailable" as const,
        parse: parseCardDocument,
      },
      {
        adapterVersion: "gundam-en-asia@1",
        sourceLineage: "gundam-en-asia",
        supportedGame: "gundam",
        gameProfileVersion: "gundam@1",
        parserContract: "gundam-card-document@1",
        maximumJsonBytes: 1024 * 1024,
        origin: "production" as const,
        reconciliationCoverage: "unavailable" as const,
        parse: parseCardDocument,
      },
      {
        adapterVersion: "gundam-en-us@1",
        sourceLineage: "gundam-en-us",
        supportedGame: "gundam",
        gameProfileVersion: "gundam@1",
        parserContract: "gundam-card-document@1",
        maximumJsonBytes: 1024 * 1024,
        origin: "production" as const,
        reconciliationCoverage: "unavailable" as const,
        parse: parseCardDocument,
      },
      ...[
        {
          adapterVersion: "fixture-one-piece-json@1",
          sourceLineage: "one-piece-en",
          supportedGame: "one-piece",
          gameProfileVersion: "one-piece@1",
          parserContract: "synthetic-fixture-card-document@1",
        },
        {
          adapterVersion: "fixture-fusion-world-json@1",
          sourceLineage: "fusion-world-en",
          supportedGame: "fusion-world",
          gameProfileVersion: "fusion-world@1",
          parserContract: "synthetic-fixture-card-document@1",
        },
        {
          adapterVersion: "fixture-digimon-json@1",
          sourceLineage: "digimon-en",
          supportedGame: "digimon",
          gameProfileVersion: "digimon@1",
          parserContract: "synthetic-fixture-card-document@1",
        },
        {
          adapterVersion: "fixture-gundam-en-asia-json@1",
          sourceLineage: "gundam-en-asia",
          supportedGame: "gundam",
          gameProfileVersion: "gundam@1",
          parserContract: "synthetic-fixture-card-document@1",
        },
        {
          adapterVersion: "fixture-gundam-en-us-json@1",
          sourceLineage: "gundam-en-us",
          supportedGame: "gundam",
          gameProfileVersion: "gundam@1",
          parserContract: "synthetic-fixture-card-document@1",
        },
      ].map((adapter) => ({
        ...adapter,
        maximumJsonBytes: 1024 * 1024,
        origin: "synthetic_fixture" as const,
        reconciliationCoverage: "synthetic_fixture" as const,
        parse: parseCardDocument,
      })),
    ].map((adapter) => Object.freeze(adapter)),
  );

const installedAdapters = new Map<string, SourceAdapterRegistration>(
  sourceAdapterRegistrations.map((adapter) => [
    adapter.adapterVersion,
    adapter,
  ]),
);

export function requiredSourceAdapter(
  adapterVersion: string,
): SourceAdapterRegistration {
  const adapter = installedAdapters.get(adapterVersion);
  if (adapter === undefined) {
    throw new AdministrationProblem(
      422,
      "adapter_not_supported",
      "The requested Official Source adapter version is not installed.",
    );
  }
  return adapter;
}

export function assertAdapterBinding(
  adapter: SourceAdapterRegistration,
  input: {
    sourceLineage: string;
    supportedGame: string;
    gameProfileVersion?: string;
  },
): void {
  if (
    adapter.sourceLineage !== input.sourceLineage ||
    adapter.supportedGame !== input.supportedGame ||
    (input.gameProfileVersion !== undefined &&
      adapter.gameProfileVersion !== input.gameProfileVersion)
  ) {
    throw new AdministrationProblem(
      422,
      "adapter_binding_mismatch",
      "The adapter version is not registered for this Supported Game, Game Profile, and Official Source lineage.",
    );
  }
}
