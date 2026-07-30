import { AdministrationProblem } from "./ingestion";
import {
  officialRawAdapterContracts,
} from "./product-release-source-adapters";

export type SourceAdapterRegistration = Readonly<{
  adapterVersion: string;
  sourceLineage: string;
  supportedGame: string;
  gameProfileVersion: string;
  parserContract: string;
  maximumSnapshotBytes: number;
  origin: "production" | "synthetic_fixture";
  reconciliationCoverage:
    | "official_source"
    | "synthetic_fixture"
    | "unavailable";
  parse?: (document: unknown) => readonly unknown[];
  parseBytes?: (
    bytes: Uint8Array,
    context: { mediaType: string | null; url: string; requestId?: string },
  ) => readonly unknown[];
  discoverRequests?: (
    bytes: Uint8Array,
    context: { mediaType: string | null; url: string; requestId?: string },
  ) => readonly {
    role: "listing" | "detail" | "product_detail" | "image";
    url: string;
    headers: Record<string, string>;
  }[];
  requiredSurfaces?: readonly string[];
  requestUrlForSurface?: (surface: string) => string;
}>;

const parseSourceDocument = (document: unknown): readonly unknown[] => {
  if (
    typeof document === "object" &&
    document !== null &&
    !Array.isArray(document)
  ) {
    const record = document as {
      cards?: unknown;
      product_surfaces?: unknown;
    };
    if (
      Array.isArray(record.cards) ||
      Array.isArray(record.product_surfaces)
    ) {
      return [
        ...(Array.isArray(record.cards) ? record.cards : []),
        ...(Array.isArray(record.product_surfaces)
          ? record.product_surfaces
          : []),
      ];
    }
  }
  return [document];
};

export const sourceAdapterRegistrations: readonly SourceAdapterRegistration[] =
  Object.freeze(
    [
      ...officialRawAdapterContracts.map((adapter) => ({
        adapterVersion: adapter.adapterVersion,
        sourceLineage: adapter.sourceLineage,
        supportedGame: adapter.supportedGame,
        gameProfileVersion: `${adapter.supportedGame}@1`,
        parserContract: `${adapter.sourceLineage}-raw-surfaces@1`,
        maximumSnapshotBytes: 16 * 1024 * 1024,
        origin: "production" as const,
        reconciliationCoverage: "official_source" as const,
        parseBytes: adapter.parseBytes,
        discoverRequests: adapter.discoverRequests,
        requiredSurfaces: adapter.requiredSurfaces,
        requestUrlForSurface: adapter.requestUrlForSurface,
      })),
      ...[
        {
          adapterVersion: "one-piece-json-document@1",
          sourceLineage: "one-piece-en",
          supportedGame: "one-piece",
          gameProfileVersion: "one-piece@1",
          parserContract: "synthetic-fixture-card-document@1",
        },
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
        maximumSnapshotBytes:
          adapter.adapterVersion === "one-piece-json-document@1"
            ? 1024 * 1024
            : 16 * 1024 * 1024,
        origin: "synthetic_fixture" as const,
        reconciliationCoverage: "synthetic_fixture" as const,
        parse: parseSourceDocument,
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
