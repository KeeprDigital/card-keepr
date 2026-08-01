import { AdministrationProblem } from "./administration-problem.mjs";
import {
  officialRawAdapterContracts,
} from "./official-raw-adapter-contracts.mjs";
import { parseOnePieceOfficialErrataHtml } from "./one-piece-official-errata-html.mjs";

export type OfficialSourceContract = Readonly<{
  supportedGame: "one-piece" | "fusion-world" | "digimon" | "gundam";
  partition: "EN-OCEANIA" | "EN-ASIA" | "EN-US";
  origin: string;
  pathnamePrefix: string;
  requiredSurfaces: readonly string[];
}>;

export type SourceAdapterRegistration = Readonly<{
  adapterVersion: string;
  sourceLineage: string;
  supportedGame: string;
  gameProfileVersion: string;
  parserContract: string;
  maximumSnapshotBytes: number;
  origin: "production" | "synthetic_fixture";
  requestSurface:
    | Readonly<{ kind: "credential-free-https" }>
    | Readonly<{ kind: "exact-url"; url: string }>
    | Readonly<{ kind: "synthetic-fixture" }>;
  reconciliationCapability: "catalogue" | "errata" | "unavailable";
  parse?: (
    document: unknown,
  ) => readonly unknown[] | Promise<readonly unknown[]>;
  parseBytes?: (
    bytes: Uint8Array,
    context: { mediaType: string | null; url: string; requestId?: string },
  ) => readonly unknown[] | Promise<readonly unknown[]>;
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
  officialSourceContract?: OfficialSourceContract;
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

const parseLegalitySourceDocument = (document: unknown): readonly unknown[] => {
  if (
    typeof document === "object" &&
    document !== null &&
    !Array.isArray(document)
  ) {
    const record = document as {
      cards?: unknown;
      product_surfaces?: unknown;
      legality_rules?: unknown;
      legality_completeness?: unknown;
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
        ...(record.legality_rules === undefined
          ? []
          : [{
              observation_type: "legality_rules",
              legality_rules: record.legality_rules,
              completeness: record.legality_completeness,
            }]),
      ];
    }
  }
  return [document];
};

const parsePinnedCardDocument = (document: unknown): readonly unknown[] => {
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

export function requiredOfficialSourceContract(
  adapter: SourceAdapterRegistration,
): OfficialSourceContract {
  if (
    adapter.reconciliationCapability !== "catalogue" ||
    adapter.officialSourceContract === undefined
  ) {
    throw new Error(
      `Adapter ${adapter.adapterVersion} has no complete Official Source contract.`,
    );
  }
  return adapter.officialSourceContract;
}

export function assertOfficialSourceUrl(
  value: string,
  contract: OfficialSourceContract,
): URL {
  const url = new URL(value);
  if (
    url.origin !== contract.origin ||
    !url.pathname.startsWith(contract.pathnamePrefix) ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      `Official Source URL must be within ${contract.origin}${contract.pathnamePrefix}.`,
    );
  }
  return url;
}

export const sourceAdapterRegistrations: readonly SourceAdapterRegistration[] =
  Object.freeze(
    [
      {
        adapterVersion: "one-piece-official-errata-html@1",
        sourceLineage: "one-piece-en",
        supportedGame: "one-piece",
        gameProfileVersion: "one-piece@1",
        parserContract: "one-piece-official-errata-html@1",
        maximumSnapshotBytes: 1024 * 1024,
        origin: "production" as const,
        requestSurface: {
          kind: "exact-url" as const,
          url: "https://en.onepiece-cardgame.com/rules/errata_card/",
        },
        requiredSurfaces: ["errata"],
        requestUrlForSurface: (surface: string) => {
          if (surface !== "errata") {
            throw new Error("Official Errata surface identity is invalid.");
          }
          return "https://en.onepiece-cardgame.com/rules/errata_card/";
        },
        reconciliationCapability: "errata" as const,
        parseBytes: (bytes: Uint8Array) => {
          const document = new TextDecoder(
            "utf-8",
            { fatal: true, ignoreBOM: false },
          ).decode(bytes);
          return parseOnePieceOfficialErrataHtml(document);
        },
      },
      ...officialRawAdapterContracts.map((adapter) => ({
        adapterVersion: adapter.adapterVersion,
        sourceLineage: adapter.sourceLineage,
        supportedGame: adapter.supportedGame,
        gameProfileVersion: `${adapter.supportedGame}@1`,
        parserContract: adapter.parserContract,
        maximumSnapshotBytes: 16 * 1024 * 1024,
        origin: "production" as const,
        requestSurface: { kind: "credential-free-https" as const },
        reconciliationCapability: "catalogue" as const,
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
          parserContract: "one-piece-card-document@1",
          maximumSnapshotBytes: 1024 * 1024,
          parse: parsePinnedCardDocument,
        },
        {
          adapterVersion: "one-piece-json-document@2",
          sourceLineage: "one-piece-en",
          supportedGame: "one-piece",
          gameProfileVersion: "one-piece@1",
          parserContract: "one-piece-card-document@1",
          maximumSnapshotBytes: 1024 * 1024,
          parse: parsePinnedCardDocument,
        },
        {
          adapterVersion: "fusion-world-en@1",
          sourceLineage: "fusion-world-en",
          supportedGame: "fusion-world",
          gameProfileVersion: "fusion-world@1",
          parserContract: "fusion-world-card-document@1",
          maximumSnapshotBytes: 1024 * 1024,
          parse: parsePinnedCardDocument,
        },
        {
          adapterVersion: "digimon-en@1",
          sourceLineage: "digimon-en",
          supportedGame: "digimon",
          gameProfileVersion: "digimon@1",
          parserContract: "digimon-card-document@1",
          maximumSnapshotBytes: 1024 * 1024,
          parse: parsePinnedCardDocument,
        },
        {
          adapterVersion: "gundam-en-asia@1",
          sourceLineage: "gundam-en-asia",
          supportedGame: "gundam",
          gameProfileVersion: "gundam@1",
          parserContract: "gundam-card-document@1",
          maximumSnapshotBytes: 1024 * 1024,
          parse: parsePinnedCardDocument,
        },
        {
          adapterVersion: "gundam-en-us@1",
          sourceLineage: "gundam-en-us",
          supportedGame: "gundam",
          gameProfileVersion: "gundam@1",
          parserContract: "gundam-card-document@1",
          maximumSnapshotBytes: 1024 * 1024,
          parse: parsePinnedCardDocument,
        },
      ].map((adapter) => ({
        ...adapter,
        origin: "production" as const,
        requestSurface: { kind: "credential-free-https" as const },
        reconciliationCapability: "unavailable" as const,
      })),
      {
        adapterVersion: "fixture-one-piece-official-errata-json@1",
        sourceLineage: "one-piece-en",
        supportedGame: "one-piece",
        gameProfileVersion: "one-piece@1",
        parserContract: "synthetic-official-errata-fixture@1",
        maximumSnapshotBytes: 16 * 1024 * 1024,
        origin: "synthetic_fixture" as const,
        requestSurface: { kind: "synthetic-fixture" as const },
        reconciliationCapability: "errata" as const,
        parse: parseSourceDocument,
      },
      ...[
        {
          adapterVersion: "fixture-one-piece-json@1",
          sourceLineage: "one-piece-en",
          supportedGame: "one-piece",
          gameProfileVersion: "one-piece@1",
          parserContract: "synthetic-fixture-card-document@1",
          legalityAware: false,
        },
        {
          adapterVersion: "fixture-one-piece-json@2",
          sourceLineage: "one-piece-en",
          supportedGame: "one-piece",
          gameProfileVersion: "one-piece@1",
          parserContract: "synthetic-fixture-card-document@1",
          legalityAware: false,
        },
        {
          adapterVersion: "fixture-one-piece-json@3",
          sourceLineage: "one-piece-en",
          supportedGame: "one-piece",
          gameProfileVersion: "one-piece@1",
          parserContract: "synthetic-fixture-card-document-with-legality@2",
          legalityAware: true,
        },
        {
          adapterVersion: "fixture-one-piece-json-capped@1",
          sourceLineage: "one-piece-en",
          supportedGame: "one-piece",
          gameProfileVersion: "one-piece@1",
          parserContract: "synthetic-fixture-card-document@1",
          maximumSnapshotBytes: 1024 * 1024,
          legalityAware: false,
        },
        {
          adapterVersion: "fixture-fusion-world-json@1",
          sourceLineage: "fusion-world-en",
          supportedGame: "fusion-world",
          gameProfileVersion: "fusion-world@1",
          parserContract: "synthetic-fixture-card-document@1",
          legalityAware: false,
        },
        {
          adapterVersion: "fixture-fusion-world-json@2",
          sourceLineage: "fusion-world-en",
          supportedGame: "fusion-world",
          gameProfileVersion: "fusion-world@1",
          parserContract: "synthetic-fixture-card-document-with-legality@2",
          legalityAware: true,
        },
        {
          adapterVersion: "fixture-digimon-json@1",
          sourceLineage: "digimon-en",
          supportedGame: "digimon",
          gameProfileVersion: "digimon@1",
          parserContract: "synthetic-fixture-card-document@1",
          legalityAware: false,
        },
        {
          adapterVersion: "fixture-digimon-json@2",
          sourceLineage: "digimon-en",
          supportedGame: "digimon",
          gameProfileVersion: "digimon@1",
          parserContract: "synthetic-fixture-card-document-with-legality@2",
          legalityAware: true,
        },
        {
          adapterVersion: "fixture-gundam-en-asia-json@1",
          sourceLineage: "gundam-en-asia",
          supportedGame: "gundam",
          gameProfileVersion: "gundam@1",
          parserContract: "synthetic-fixture-card-document@1",
          legalityAware: false,
        },
        {
          adapterVersion: "fixture-gundam-en-asia-json@2",
          sourceLineage: "gundam-en-asia",
          supportedGame: "gundam",
          gameProfileVersion: "gundam@1",
          parserContract: "synthetic-fixture-card-document-with-legality@2",
          legalityAware: true,
        },
        {
          adapterVersion: "fixture-gundam-en-us-json@1",
          sourceLineage: "gundam-en-us",
          supportedGame: "gundam",
          gameProfileVersion: "gundam@1",
          parserContract: "synthetic-fixture-card-document@1",
          legalityAware: false,
        },
        {
          adapterVersion: "fixture-gundam-en-us-json@2",
          sourceLineage: "gundam-en-us",
          supportedGame: "gundam",
          gameProfileVersion: "gundam@1",
          parserContract: "synthetic-fixture-card-document-with-legality@2",
          legalityAware: true,
        },
      ].map(({ legalityAware, ...adapter }) => ({
        ...adapter,
        maximumSnapshotBytes:
          adapter.maximumSnapshotBytes ?? 16 * 1024 * 1024,
        origin: "synthetic_fixture" as const,
        requestSurface: { kind: "synthetic-fixture" as const },
        reconciliationCapability: "catalogue" as const,
        parse: legalityAware
          ? parseLegalitySourceDocument
          : parseSourceDocument,
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

export function assertAdapterRequestSurface(
  adapter: SourceAdapterRegistration,
  url: URL,
): void {
  const surface = adapter.requestSurface;
  if (surface.kind !== "exact-url" || url.href === surface.url) return;
  throw new AdministrationProblem(
    422,
    "official_source_surface_mismatch",
    `The Official Errata adapter accepts only ${surface.url}.`,
  );
}
