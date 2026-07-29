import type { FixtureCandidate } from "./fixture";
import { verifyExportSchemas } from "./export-validation";
import {
  canonicalJson,
  canonicalNdjson,
  deterministicGzip,
  sha256,
  sha256Text,
  utf8,
} from "./serialization";

const componentDefinitions = [
  ["supported-games", "SupportedGameRecord", "id:utf8"],
  ["game-profiles", "GameProfileRecord", "profile:utf8"],
  ["cards", "CardRecord", "id:utf8"],
  ["printings", "PrintingRecord", "id:utf8"],
  ["printing-images", "PrintingImageRecord", "id:utf8"],
  ["products", "ProductRecord", "id:utf8"],
  ["releases", "ReleaseRecord", "id:utf8"],
  ["distribution-contexts", "DistributionContextRecord", "id:utf8"],
  ["errata", "ErratumRecord", "id:utf8"],
  ["legality-rules", "LegalityRuleRecord", "id:utf8"],
  ["relationships", "RelationshipRecord", "id:utf8"],
] as const;
const maximumFixtureExportBytes = 1_048_576;

export type ExportObject = {
  key: string;
  bytes: Uint8Array;
  contentType: string;
  contentEncoding?: string;
};

export type BuiltCatalogueExport = {
  manifest: CatalogueExportManifest;
  manifestBytes: Uint8Array;
  manifestKey: string;
  objects: readonly ExportObject[];
};

type CatalogueExportManifest = {
  format: "card-keepr-catalogue-export-manifest@1";
  serialization_profile: "card-keepr-ndjson-gzip@1";
  export_schema_major: 1;
  catalogue_revision: {
    id: string;
    content_sha256: string;
  };
  published_at: string;
  export_created_at: string;
  supported_games: readonly ["one-piece"];
  source_freshness: readonly {
    game: "one-piece";
    area: "cards-and-printings";
    checked_at: string;
  }[];
  components: readonly ExportComponent[];
  manifest_sha256: string;
};

type ExportComponent = {
  name: string;
  media_type: "application/x-ndjson";
  compression: "gzip";
  record_schema: string;
  order: "id:utf8" | "profile:utf8";
  records: number;
  uncompressed_bytes: number;
  content_sha256: string;
  compressed_bytes: number;
  compressed_sha256: string;
  content_url: string;
};

export async function buildCatalogueExport(
  candidate: FixtureCandidate,
  candidateDigest: string,
  catalogueRevisionId: string,
  publishedAt: string,
): Promise<BuiltCatalogueExport> {
  const records = exportRecords(candidate, catalogueRevisionId);
  const components: ExportComponent[] = [];
  const objects: ExportObject[] = [];

  for (const [name, schemaDefinition, order] of componentDefinitions) {
    const componentRecords = records[name];
    const uncompressed = canonicalNdjson(componentRecords);
    const compressed = deterministicGzip(uncompressed);
    const [contentDigest, compressedDigest] = await Promise.all([
      sha256(uncompressed),
      sha256(compressed),
    ]);
    const key = `catalogue-exports/${catalogueRevisionId}/components/${compressedDigest}.ndjson.gz`;
    components.push({
      name,
      media_type: "application/x-ndjson",
      compression: "gzip",
      record_schema: `https://card-keepr.invalid/schemas/catalogue-export-record@1#/$defs/${schemaDefinition}`,
      order,
      records: componentRecords.length,
      uncompressed_bytes: uncompressed.byteLength,
      content_sha256: contentDigest,
      compressed_bytes: compressed.byteLength,
      compressed_sha256: compressedDigest,
      content_url: `/v1/catalogue-exports/${catalogueRevisionId}/components/${name}`,
    });
    objects.push({
      key,
      bytes: compressed,
      contentType: "application/x-ndjson",
      contentEncoding: "gzip",
    });
    assertFixtureExportIsBounded(objects);
  }

  const manifestWithPlaceholder: CatalogueExportManifest = {
    format: "card-keepr-catalogue-export-manifest@1",
    serialization_profile: "card-keepr-ndjson-gzip@1",
    export_schema_major: 1,
    catalogue_revision: {
      id: catalogueRevisionId,
      content_sha256: candidateDigest,
    },
    published_at: publishedAt,
    export_created_at: publishedAt,
    supported_games: ["one-piece"],
    source_freshness: [
      {
        game: "one-piece",
        area: "cards-and-printings",
        checked_at: publishedAt,
      },
    ],
    components,
    manifest_sha256: "0".repeat(64),
  };
  const manifestDigest = await sha256Text(
    `${canonicalJson(manifestWithPlaceholder)}\n`,
  );
  const manifest: CatalogueExportManifest = {
    ...manifestWithPlaceholder,
    manifest_sha256: manifestDigest,
  };
  verifyExportSchemas(
    manifest,
    componentDefinitions.map(([name]) => records[name]),
  );
  const manifestBytes = utf8(`${canonicalJson(manifest)}\n`);
  const manifestKey = `catalogue-exports/${catalogueRevisionId}/manifest.json`;
  const manifestObject = {
    key: manifestKey,
    bytes: manifestBytes,
    contentType: "application/json",
  };
  const boundedObjects = [...objects, manifestObject];
  assertFixtureExportIsBounded(boundedObjects);

  return {
    manifest,
    manifestBytes,
    manifestKey,
    objects: boundedObjects,
  };
}

function assertFixtureExportIsBounded(
  objects: readonly ExportObject[],
): void {
  const bytes = objects.reduce(
    (total, object) => total + object.bytes.byteLength,
    0,
  );
  if (bytes > maximumFixtureExportBytes) {
    throw new Error(
      "The controlled fixture Catalogue Export exceeds its 1 MiB memory bound",
    );
  }
}

function exportRecords(
  candidate: FixtureCandidate,
  revisionId: string,
): Record<(typeof componentDefinitions)[number][0], readonly unknown[]> {
  const lifecycle = {
    first_revision_id: revisionId,
    last_observed_revision_id: revisionId,
    withdrawn: false,
  };
  return {
    "supported-games": [
      {
        type: "supported_game",
        id: "game_one_piece",
        key: "one-piece",
        name: "One Piece Card Game",
        supported_locales: ["EN-OCEANIA"],
        game_profile: "one-piece@1",
      },
    ],
    "game-profiles": [
      {
        type: "game_profile",
        profile: "one-piece@1",
        game: "one-piece",
        schema: { type: "object" },
      },
    ],
    cards: candidate.cards.map((card) => ({
      type: "card",
      ...card,
      lifecycle,
    })),
    printings: candidate.printings.map((printing) => ({
      type: "printing",
      ...printing,
      lifecycle,
    })),
    "printing-images": [],
    products: [],
    releases: [],
    "distribution-contexts": [],
    errata: [],
    "legality-rules": [],
    relationships: [],
  };
}
