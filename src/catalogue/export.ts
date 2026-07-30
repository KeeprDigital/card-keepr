import type { FixtureCandidate, SupportedGame } from "./fixture";
import type {
  NormalizedLifecycle,
  RelationshipEvidence,
} from "./reconciliation-publication";
import { exportedGameProfileSchema } from "./reconciliation-profile";
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
  supported_games: readonly SupportedGame[];
  source_freshness: readonly {
    game: SupportedGame;
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
  lifecycles?: {
    cards: Readonly<Record<string, NormalizedLifecycle>>;
    printings: Readonly<Record<string, NormalizedLifecycle>>;
    products?: Readonly<Record<string, NormalizedLifecycle>>;
    relationships?: Readonly<Record<string, readonly RelationshipEvidence[]>>;
  },
  sourceFreshness?: Readonly<Partial<Record<SupportedGame, string>>>,
): Promise<BuiltCatalogueExport> {
  const records = await exportRecords(
    candidate,
    catalogueRevisionId,
    lifecycles,
  );
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
    supported_games: candidate.selected_games,
    source_freshness: candidate.selected_games.map((game) => ({
        game,
        area: "cards-and-printings",
        checked_at: sourceFreshness?.[game] ?? publishedAt,
      })),
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

async function exportRecords(
  candidate: FixtureCandidate,
  revisionId: string,
  lifecycles?: {
    cards: Readonly<Record<string, NormalizedLifecycle>>;
    printings: Readonly<Record<string, NormalizedLifecycle>>;
    products?: Readonly<Record<string, NormalizedLifecycle>>;
    relationships?: Readonly<Record<string, readonly RelationshipEvidence[]>>;
  },
): Promise<
  Record<(typeof componentDefinitions)[number][0], readonly unknown[]>
> {
  const defaultLifecycle = {
    first_revision_id: revisionId,
    last_observed_revision_id: revisionId,
    withdrawn: false,
  };
  const cardsById = new Map(candidate.cards.map((card) => [card.id, card]));
  const relationshipEvidence = candidate.printings.flatMap((printing) =>
    (lifecycles?.relationships?.[printing.id] ?? []).map((relationship) => ({
      printing,
      card: cardsById.get(printing.card_id)!,
      relationship,
    })),
  );
  const canonicalRelationshipEvidence = relationshipEvidence.filter(
    ({ relationship }) =>
      relationship.relationship_kind !== "source_bucket",
  );
  const identifiedRelationships = await Promise.all(
    canonicalRelationshipEvidence.map(
      async ({ printing, card, relationship }) => {
        const targetId =
          relationship.relationship_kind === "product"
            ? await productExportId(
                card.game,
                relationship.relationship_value,
              )
            : await distributionContextExportId(
                card.game,
                relationship.source_lineage,
                relationship.relationship_value,
              );
        return {
          printing,
          card,
          relationship,
          targetId,
          relationshipId: await relationshipExportId(
            card.game,
            printing.id,
            relationship,
            targetId,
          ),
        };
      },
    ),
  );
  const products = uniqueById(
    identifiedRelationships
      .filter(
        ({ relationship }) =>
          relationship.relationship_kind === "product",
      )
      .map(({ card, relationship, targetId }) => ({
        type: "product",
        id: targetId,
        game: card.game,
        official_code: relationship.relationship_value,
        name: relationship.relationship_value,
        lifecycle:
          lifecycles?.products?.[
            productLifecycleKey(card.game, relationship.relationship_value)
          ] ?? {
            first_revision_id: relationship.first_revision_id,
            last_observed_revision_id:
              relationship.last_observed_revision_id,
            withdrawn: false,
          },
      })),
  );
  const distributionContexts = uniqueById(
    identifiedRelationships
      .filter(
        ({ relationship }) =>
          relationship.relationship_kind === "distribution_context",
      )
      .map(({ card, relationship, targetId }) => ({
        type: "distribution_context",
        id: targetId,
        game: card.game,
        kind: "other",
        label: relationship.relationship_value,
        product_id: null,
      })),
  );
  return {
    "supported-games": candidate.selected_games.map((game) => ({
        type: "supported_game",
        ...supportedGameExport(game),
      })),
    "game-profiles": candidate.selected_games.map((game) => ({
        type: "game_profile",
        profile: `${game}@1`,
        game,
        schema: exportedGameProfileSchema(`${game}@1`),
      })),
    cards: candidate.cards.map((card) => ({
      type: "card",
      ...card,
      lifecycle: lifecycles?.cards[card.id] ?? defaultLifecycle,
    })),
    printings: candidate.printings.map((printing) => ({
      type: "printing",
      ...printing,
      lifecycle: lifecycles?.printings[printing.id] ?? defaultLifecycle,
    })),
    "printing-images": [],
    products,
    releases: [],
    "distribution-contexts": distributionContexts,
    errata: [],
    "legality-rules": [],
    relationships: identifiedRelationships
      .map(({ printing, relationship, relationshipId, targetId }) => ({
        type: "relationship",
        id: relationshipId,
        kind:
          relationship.relationship_kind === "product"
            ? "printing-product"
            : "printing-distribution-context",
        from: { type: "printing", id: printing.id },
        to: {
          type:
            relationship.relationship_kind === "product"
              ? "product"
              : "distribution_context",
          id: targetId,
        },
        evidence_category: "explicit",
        source_lineage: relationship.source_lineage,
        source_observation_ids: relationship.source_observation_ids,
        relationship_value: relationship.relationship_value,
        lifecycle: {
          first_revision_id: relationship.first_revision_id,
          last_observed_revision_id:
            relationship.last_observed_revision_id,
          current: relationship.current,
          last_missing_revision_id:
            relationship.last_missing_revision_id,
        },
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function productLifecycleKey(game: string, officialCode: string): string {
  return canonicalJson([game, officialCode]);
}

function uniqueById<T extends { id: string }>(values: readonly T[]): T[] {
  return [...new Map(values.map((value) => [value.id, value])).values()].sort(
    (left, right) => left.id.localeCompare(right.id),
  );
}

async function relationshipExportId(
  game: SupportedGame,
  printingId: string,
  relationship: RelationshipEvidence,
  targetId: string,
): Promise<string> {
  return `relationship_${await sha256Text(
    canonicalJson({
      game,
      printing_id: printingId,
      source_lineage: relationship.source_lineage,
      relationship_kind: relationship.relationship_kind,
      relationship_value: relationship.relationship_value,
      target_id: targetId,
    }),
  )}`;
}

async function productExportId(
  game: SupportedGame,
  officialCode: string,
): Promise<string> {
  return `product_${await sha256Text(
    canonicalJson({ game, official_code: officialCode }),
  )}`;
}

export async function distributionContextExportId(
  game: SupportedGame,
  sourceLineage: string,
  label: string,
): Promise<string> {
  return `distribution_context_${await sha256Text(
    canonicalJson({
      game,
      source_lineage: sourceLineage,
      label,
    }),
  )}`;
}

function supportedGameExport(game: SupportedGame) {
  const definitions = {
    "one-piece": {
      id: "game_one_piece",
      key: "one-piece",
      name: "One Piece Card Game",
      supported_locales: ["EN-OCEANIA"],
      game_profile: "one-piece@1",
    },
    "fusion-world": {
      id: "game_fusion_world",
      key: "fusion-world",
      name: "Dragon Ball Super Card Game Fusion World",
      supported_locales: ["EN-OCEANIA"],
      game_profile: "fusion-world@1",
    },
    digimon: {
      id: "game_digimon",
      key: "digimon",
      name: "Digimon Card Game",
      supported_locales: ["EN-OCEANIA"],
      game_profile: "digimon@1",
    },
    gundam: {
      id: "game_gundam",
      key: "gundam",
      name: "Gundam Card Game",
      supported_locales: ["EN-ASIA", "EN-US"],
      game_profile: "gundam@1",
    },
  } as const;
  return definitions[game];
}
