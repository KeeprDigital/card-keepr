import {
  registerSourceAdapters,
  type SourceAdapterRegistration,
} from "../../../src/catalogue/adapters/source-adapters";

const parseCardSourceDocument = (document: unknown): readonly unknown[] => {
  if (typeof document === "object" && document !== null && !Array.isArray(document)) {
    const record = document as {
      cards?: unknown;
      product_surfaces?: unknown;
    };
    if (Array.isArray(record.cards) || Array.isArray(record.product_surfaces)) {
      return [
        ...(Array.isArray(record.cards) ? record.cards : []),
        ...(Array.isArray(record.product_surfaces) ? record.product_surfaces : []),
      ];
    }
  }
  return [document];
};

export const syntheticAdapterRegistrations: readonly SourceAdapterRegistration[] = Object.freeze(
  [
    {
      adapterVersion: "fixture-one-piece-official-errata-json@1",
      sourceLineage: "one-piece-en",
      supportedGame: "one-piece",
      gameProfileVersion: "one-piece@1",
      parserContract: "synthetic-official-errata-fixture@1",
      maximumSnapshotBytes: 16 * 1024 * 1024,
      origin: "production" as const,
      requestSurface: { kind: "credential-free-https" as const },
      reconciliationCapability: "errata" as const,
      parse: parseCardSourceDocument,
    },
    // Before Go-Live (ADR 0008) each Source Lineage keeps one synthetic
    // fixture adapter; the -capped and -large fixtures are distinct
    // behaviours (byte cap, request capacity), not versions. Every fixture
    // shares the card-content parser contract.
    ...[
      {
        adapterVersion: "fixture-one-piece-json@3",
        sourceLineage: "one-piece-en",
        supportedGame: "one-piece",
        gameProfileVersion: "one-piece@1",
        parserContract: "synthetic-fixture-card-document@2",
      },
      {
        adapterVersion: "fixture-one-piece-json-capped@1",
        sourceLineage: "one-piece-en",
        supportedGame: "one-piece",
        gameProfileVersion: "one-piece@1",
        parserContract: "synthetic-fixture-card-document@2",
        maximumSnapshotBytes: 1024 * 1024,
      },
      {
        adapterVersion: "fixture-fusion-world-json@2",
        sourceLineage: "fusion-world-en",
        supportedGame: "fusion-world",
        gameProfileVersion: "fusion-world@1",
        parserContract: "synthetic-fixture-card-document@2",
      },
      {
        adapterVersion: "fixture-fusion-world-json-large@1",
        sourceLineage: "fusion-world-en",
        supportedGame: "fusion-world",
        gameProfileVersion: "fusion-world@1",
        parserContract: "synthetic-fixture-card-document@2",
      },
      {
        adapterVersion: "fixture-digimon-json@2",
        sourceLineage: "digimon-en",
        supportedGame: "digimon",
        gameProfileVersion: "digimon@1",
        parserContract: "synthetic-fixture-card-document@2",
      },
      {
        adapterVersion: "fixture-gundam-en-asia-json@2",
        sourceLineage: "gundam-en-asia",
        supportedGame: "gundam",
        gameProfileVersion: "gundam@1",
        parserContract: "synthetic-fixture-card-document@2",
      },
      {
        adapterVersion: "fixture-gundam-en-us-json@2",
        sourceLineage: "gundam-en-us",
        supportedGame: "gundam",
        gameProfileVersion: "gundam@1",
        parserContract: "synthetic-fixture-card-document@2",
      },
    ].map((adapter) => ({
      ...adapter,
      maximumSnapshotBytes: adapter.maximumSnapshotBytes ?? 16 * 1024 * 1024,
      origin: "production" as const,
      requestSurface: { kind: "credential-free-https" as const },
      reconciliationCapability: "catalogue" as const,
      parse: parseCardSourceDocument,
    })),
  ].map((adapter) =>
    Object.freeze({
      ...adapter,
      requestCapacity: adapter.adapterVersion === "fixture-fusion-world-json-large@1" ? 15_000 : 5_000,
    }),
  ),
);

export function registerSyntheticSourceAdapters(): void {
  registerSourceAdapters(syntheticAdapterRegistrations);
}
