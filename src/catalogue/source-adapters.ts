import { AdministrationProblem } from "./administration-problem.mjs";
import {
  officialRawAdapterContracts,
} from "./official-raw-adapter-contracts.mjs";
import { parseOnePieceOfficialErrataHtml } from "./one-piece-official-errata-html.mjs";

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

const parsePinnedCardDocument = (document: unknown): readonly unknown[] => {
  if (
    typeof document === "object" &&
    document !== null &&
    !Array.isArray(document) &&
    Array.isArray((document as { cards?: unknown }).cards)
  ) {
    const source = document as {
      cards: unknown[];
      legality_rules?: unknown;
      legality_completeness?: unknown;
    };
    return [
      ...source.cards,
      ...(source.legality_rules === undefined
        ? []
        : [
            {
              observation_type: "legality_rules",
              legality_rules: source.legality_rules,
              completeness: source.legality_completeness,
            },
          ]),
    ];
  }
  return [document];
};

function officialCatalogueParser(
  requiredPartition: "EN-OCEANIA" | "EN-ASIA" | "EN-US",
): (document: unknown) => readonly unknown[] {
  return (document) => {
    const envelope = requiredRecord(
      document,
      "Official Source catalogue document",
    );
    assertOnlyFields(envelope, ["surfaces"]);
    const surfaces = requiredRecord(
      envelope.surfaces,
      "Official Source surfaces",
    );
    assertOnlyFields(surfaces, ["cards", "legality_rules"]);
    if (surfaces.cards === undefined) {
      throw new Error("The required Card surface is missing.");
    }
    if (surfaces.legality_rules === undefined) {
      throw new Error("The required Legality Rule surface is missing.");
    }
    const cards = parseOfficialSurface(
      surfaces.cards,
      "Card",
      requiredPartition,
    );
    const legalityRules = parseOfficialSurface(
      surfaces.legality_rules,
      "Legality Rule",
      requiredPartition,
    );
    return [
      ...cards.map((card) => ({
        ...requiredRecord(card, "Official Card record"),
        completeness: completeObservationEvidence(),
      })),
      {
        observation_type: "legality_rules",
        legality_rules: legalityRules,
        completeness: completeObservationEvidence(),
      },
    ];
  };
}

function parseOfficialSurface(
  value: unknown,
  name: "Card" | "Legality Rule",
  requiredPartition: "EN-OCEANIA" | "EN-ASIA" | "EN-US",
): unknown[] {
  const surface = requiredRecord(value, `${name} surface`);
  assertOnlyFields(surface, [
    "partition",
    "declared_record_count",
    "pages",
  ]);
  if (surface.partition !== requiredPartition) {
    throw new Error(
      `${name} surface partition does not match its Source Lineage.`,
    );
  }
  const declaredRecordCount = requiredCount(
    surface.declared_record_count,
    `${name} surface declared record count`,
  );
  if (!Array.isArray(surface.pages)) {
    throw new Error(`${name} surface pages must be an array.`);
  }
  if (declaredRecordCount > 0 && surface.pages.length === 0) {
    throw new Error(
      `${name} surface declared records but retained no pages.`,
    );
  }
  const records: unknown[] = [];
  const totalPages = surface.pages.length;
  for (const [index, valuePage] of surface.pages.entries()) {
    const page = requiredRecord(valuePage, `${name} surface page`);
    assertOnlyFields(page, [
      "number",
      "total_pages",
      "declared_record_count",
      "records",
    ]);
    if (
      page.number !== index + 1 ||
      page.total_pages !== totalPages
    ) {
      throw new Error(
        `${name} surface pages do not prove an exact complete partition.`,
      );
    }
    if (!Array.isArray(page.records)) {
      throw new Error(`${name} surface page records must be an array.`);
    }
    const pageDeclaredCount = requiredCount(
      page.declared_record_count,
      `${name} surface page declared record count`,
    );
    if (pageDeclaredCount !== page.records.length) {
      throw new Error(
        `${name} surface declared and parsed record counts differ.`,
      );
    }
    records.push(...page.records);
  }
  if (records.length !== declaredRecordCount) {
    throw new Error(
      `${name} surface declared and parsed record counts differ.`,
    );
  }
  return records;
}

function completeObservationEvidence() {
  return {
    structurally_complete: true,
    required_surfaces_complete: true,
    partitions_complete: true,
    declared_record_count: 1,
    parsed_record_count: 1,
  };
}

function requiredCount(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return Number(value);
}

function requiredRecord(
  value: unknown,
  name: string,
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): void {
  const allowed = new Set(fields);
  const unexpected = Object.keys(value).find(
    (field) => !allowed.has(field),
  );
  if (unexpected !== undefined) {
    throw new Error(
      `Official Source surface field ${unexpected} is unsupported.`,
    );
  }
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
        parserContract: `${adapter.sourceLineage}-raw-surfaces@1`,
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
      {
        adapterVersion: "gundam-en-asia@2",
        sourceLineage: "gundam-en-asia",
        supportedGame: "gundam",
        gameProfileVersion: "gundam@1",
        parserContract: "gundam-card-and-legality-document@2",
        maximumJsonBytes: 1024 * 1024,
        origin: "production" as const,
        reconciliationCoverage: "official_complete" as const,
        parse: officialCatalogueParser("EN-ASIA"),
      },
      {
        adapterVersion: "gundam-en-us@2",
        sourceLineage: "gundam-en-us",
        supportedGame: "gundam",
        gameProfileVersion: "gundam@1",
        parserContract: "gundam-card-and-legality-document@2",
        maximumJsonBytes: 1024 * 1024,
        origin: "production" as const,
        reconciliationCoverage: "official_complete" as const,
        parse: officialCatalogueParser("EN-US"),
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
          adapterVersion: "fixture-one-piece-json@2",
          sourceLineage: "one-piece-en",
          supportedGame: "one-piece",
          gameProfileVersion: "one-piece@1",
          parserContract: "synthetic-fixture-card-document@1",
        },
        {
          adapterVersion: "fixture-one-piece-json-capped@1",
          sourceLineage: "one-piece-en",
          supportedGame: "one-piece",
          gameProfileVersion: "one-piece@1",
          parserContract: "synthetic-fixture-card-document@1",
          maximumSnapshotBytes: 1024 * 1024,
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
          adapter.maximumSnapshotBytes ?? 16 * 1024 * 1024,
        origin: "synthetic_fixture" as const,
        requestSurface: { kind: "synthetic-fixture" as const },
        reconciliationCapability: "catalogue" as const,
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
