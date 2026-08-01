import type {
  CatalogueCandidate,
  SupportedGame,
} from "./catalogue-candidate";
import type {
  NormalizedLifecycle,
  LocatorEvidenceCollection,
  RelationshipEvidence,
} from "./reconciliation-publication";
import { exportedGameProfileSchema } from "./reconciliation-profile";
import {
  verifyExportManifest,
  verifyExportRecord,
} from "./export-validation";
import {
  canonicalJson,
  compareUtf8,
  sha256,
  sha256Text,
  utf8,
} from "./serialization";
import { typedPrintingProjections } from "./product-release-projection";
import {
  erratumTargetLifecycleKey,
  exportErratum,
} from "./errata-rules-text";
import {
  legalityRuleExportRecords,
  legalityRuleRelationshipRecords,
} from "./legality-export";
import {
  CatalogueExportLimitError,
  maximumCatalogueExportBytes,
  maximumCatalogueExportObjectBytes,
  maximumExportComponentBytes,
  maximumExportRecordBytes,
} from "./export-limits";
import { deterministicGzipStream } from "./export-compression";

const componentDefinitions = [
  ["supported-games", "SupportedGameRecord", "id:utf8", 2],
  ["game-profiles", "GameProfileRecord", "profile:utf8", 2],
  ["cards", "CardRecord", "id:utf8", 2],
  ["printings", "PrintingRecord", "id:utf8", 2],
  ["printing-images", "PrintingImageRecord", "id:utf8", 2],
  ["products", "ProductRecord", "id:utf8", 2],
  ["releases", "ReleaseRecord", "id:utf8", 2],
  ["distribution-contexts", "DistributionContextRecord", "id:utf8", 2],
  ["errata", "ErratumRecord", "id:utf8", 2],
  ["legality-rules", "LegalityRuleRecord", "id:utf8", 2],
  ["relationships", "RelationshipRecord", "id:utf8", 2],
] as const;

export type ExportObject = {
  key: string;
  byteLength: number;
  sha256: string;
  body: () => {
    readable: ReadableStream<Uint8Array>;
    completed: Promise<void>;
  };
  contentType: string;
  contentEncoding?: string;
};

export type BuiltCatalogueExport = {
  manifest: CatalogueExportManifest;
  manifestBytes: Uint8Array;
  manifestKey: string;
  objects: readonly ExportObject[];
};

export type SourceFreshness = {
  game: SupportedGame;
  area:
    | "cards-and-printings"
    | "products-and-releases"
    | "legality-rules"
    | "errata";
  checked_at: string;
};

type CatalogueExportManifest = {
  format: "card-keepr-catalogue-export-manifest@2";
  serialization_profile: "card-keepr-ndjson-gzip@1";
  export_schema_major: 2;
  catalogue_revision: {
    id: string;
    content_sha256: string;
  };
  published_at: string;
  export_created_at: string;
  supported_games: readonly SupportedGame[];
  source_freshness: readonly SourceFreshness[];
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
  candidate: CatalogueCandidate,
  candidateDigest: string,
  catalogueRevisionId: string,
  publishedAt: string,
  lifecycles?: {
    cards: Readonly<Record<string, NormalizedLifecycle>>;
    printings: Readonly<Record<string, NormalizedLifecycle>>;
    products?: Readonly<Record<string, NormalizedLifecycle>>;
    productRelationships?: Readonly<
      Record<
        string,
        {
          first_revision_id: string;
          last_observed_revision_id: string;
          current: boolean;
          last_missing_revision_id: string | null;
        }
      >
    >;
    erratumTargets?: Readonly<Record<string, NormalizedLifecycle>>;
    relationships?: Readonly<Record<string, readonly RelationshipEvidence[]>>;
    locators?: Readonly<Record<string, LocatorEvidenceCollection>>;
    cardEvidence?: Readonly<
      Record<string, readonly { source: string }[]>
    >;
    printingEvidence?: Readonly<
      Record<string, readonly { source: string }[]>
    >;
  },
  sourceFreshness?: readonly SourceFreshness[],
): Promise<BuiltCatalogueExport> {
  const recordFactories = await exportRecordFactories(
    candidate,
    catalogueRevisionId,
    lifecycles,
  );
  const components: ExportComponent[] = [];
  const objects: ExportObject[] = [];
  let totalUncompressedBytes = 0;
  let totalObjectBytes = 0;

  for (const [
    name,
    schemaDefinition,
    order,
    recordSchemaMajor,
  ] of componentDefinitions) {
    const records = orderedExportRecords(recordFactories[name], order);
    const analysis = await analyseComponent(records);
    if (analysis.uncompressedBytes > maximumExportComponentBytes) {
      throw new CatalogueExportLimitError(
        "One Catalogue Export component exceeds the 12 MiB byte budget.",
      );
    }
    totalUncompressedBytes += analysis.uncompressedBytes;
    if (totalUncompressedBytes > maximumCatalogueExportBytes) {
      throw new CatalogueExportLimitError(
        "Catalogue Export exceeds the 24 MiB total byte budget.",
      );
    }
    totalObjectBytes += analysis.compressedBytes;
    if (totalObjectBytes > maximumCatalogueExportObjectBytes) {
      throw new CatalogueExportLimitError(
        "Catalogue Export exceeds the 25 MiB retained-object byte budget.",
      );
    }
    const key = `catalogue-exports/${catalogueRevisionId}/components/${analysis.compressedSha256}.ndjson.gz`;
    components.push({
      name,
      media_type: "application/x-ndjson",
      compression: "gzip",
      record_schema: `https://card-keepr.invalid/schemas/catalogue-export-record@${recordSchemaMajor}#/$defs/${schemaDefinition}`,
      order,
      records: analysis.records,
      uncompressed_bytes: analysis.uncompressedBytes,
      content_sha256: analysis.contentSha256,
      compressed_bytes: analysis.compressedBytes,
      compressed_sha256: analysis.compressedSha256,
      content_url: `/v1/catalogue-exports/${catalogueRevisionId}/components/${name}`,
    });
    objects.push({
      key,
      byteLength: analysis.compressedBytes,
      sha256: analysis.compressedSha256,
      body: () =>
        fixedLengthBody(
          deterministicGzipStream(catalogueRecordStream(records())),
          analysis.compressedBytes,
        ),
      contentType: "application/x-ndjson",
      contentEncoding: "gzip",
    });
  }

  const manifestWithPlaceholder: CatalogueExportManifest = {
    format: "card-keepr-catalogue-export-manifest@2",
    serialization_profile: "card-keepr-ndjson-gzip@1",
    export_schema_major: 2,
    catalogue_revision: {
      id: catalogueRevisionId,
      content_sha256: candidateDigest,
    },
    published_at: publishedAt,
    export_created_at: publishedAt,
    supported_games: candidate.selected_games,
    source_freshness:
      sourceFreshness === undefined
        ? candidate.selected_games.flatMap((game) => [
            ...((candidate.card_observed_games ??
              candidate.selected_games).includes(game)
              ? [{
                  game,
                  area: "cards-and-printings" as const,
                  checked_at: publishedAt,
                }]
              : []),
            ...(candidate.product_observed_games?.includes(game)
              ? [{
                  game,
                  area: "products-and-releases" as const,
                  checked_at: publishedAt,
                }]
              : []),
          ])
        : [...sourceFreshness],
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
  verifyExportManifest(manifest);
  const manifestBytes = utf8(`${canonicalJson(manifest)}\n`);
  if (
    totalObjectBytes + manifestBytes.byteLength >
      maximumCatalogueExportObjectBytes
  ) {
    throw new CatalogueExportLimitError(
      "Catalogue Export exceeds the 25 MiB retained-object byte budget.",
    );
  }
  const manifestKey = `catalogue-exports/${catalogueRevisionId}/manifest.json`;
  const manifestObjectDigest = await sha256(manifestBytes);
  const manifestObject = {
    key: manifestKey,
    byteLength: manifestBytes.byteLength,
    sha256: manifestObjectDigest,
    body: () =>
      fixedLengthBody(byteStream(manifestBytes), manifestBytes.byteLength),
    contentType: "application/json",
  };
  const boundedObjects = [...objects, manifestObject];

  return {
    manifest,
    manifestBytes,
    manifestKey,
    objects: boundedObjects,
  };
}

type ExportRecordFactory = () => Iterable<unknown>;

function orderedExportRecords(
  records: ExportRecordFactory,
  order: "id:utf8" | "profile:utf8",
): ExportRecordFactory {
  const field = order === "id:utf8" ? "id" : "profile";
  return () =>
    [...records()].sort((left, right) =>
      compareUtf8(exportOrderValue(left, field), exportOrderValue(right, field))
    );
}

function exportOrderValue(value: unknown, field: "id" | "profile"): string {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof (value as Record<string, unknown>)[field] !== "string"
  ) {
    throw new Error(`Catalogue Export record has no ${field} ordering key.`);
  }
  return (value as Record<string, string>)[field]!;
}

async function analyseComponent(
  records: ExportRecordFactory,
): Promise<{
  records: number;
  uncompressedBytes: number;
  contentSha256: string;
  compressedBytes: number;
  compressedSha256: string;
}> {
  const statistics = { records: 0 };
  const contentDigest = new crypto.DigestStream("SHA-256");
  const compressedDigest = new crypto.DigestStream("SHA-256");
  const [content, compressionInput] = catalogueRecordStream(
    records(),
    statistics,
  ).tee();
  await Promise.all([
    content.pipeTo(contentDigest),
    deterministicGzipStream(compressionInput).pipeTo(compressedDigest),
  ]);
  const [contentSha256, compressedSha256] = await Promise.all([
    contentDigest.digest,
    compressedDigest.digest,
  ]);
  return {
    records: statistics.records,
    uncompressedBytes: Number(contentDigest.bytesWritten),
    contentSha256: digestHex(contentSha256),
    compressedBytes: Number(compressedDigest.bytesWritten),
    compressedSha256: digestHex(compressedSha256),
  };
}

function catalogueRecordStream(
  records: Iterable<unknown>,
  statistics?: { records: number },
): ReadableStream<Uint8Array> {
  const iterator = records[Symbol.iterator]();
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = iterator.next();
      if (next.done) {
        controller.close();
        return;
      }
      verifyExportRecord(next.value);
      const bytes = utf8(`${canonicalJson(next.value)}\n`);
      if (bytes.byteLength > maximumExportRecordBytes) {
        controller.error(
          new CatalogueExportLimitError(
            "One Catalogue Export record exceeds 512 KiB.",
          ),
        );
        return;
      }
      if (statistics !== undefined) statistics.records += 1;
      controller.enqueue(bytes);
    },
  });
}

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function fixedLengthBody(
  source: ReadableStream<Uint8Array>,
  byteLength: number,
): {
  readable: ReadableStream<Uint8Array>;
  completed: Promise<void>;
} {
  const fixed = new FixedLengthStream(byteLength);
  return {
    readable: fixed.readable,
    completed: source.pipeTo(fixed.writable),
  };
}

function digestHex(digest: ArrayBuffer): string {
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function exportRecordFactories(
  candidate: CatalogueCandidate,
  revisionId: string,
  lifecycles?: {
    cards: Readonly<Record<string, NormalizedLifecycle>>;
    printings: Readonly<Record<string, NormalizedLifecycle>>;
    products?: Readonly<Record<string, NormalizedLifecycle>>;
    productRelationships?: Readonly<
      Record<
        string,
        {
          first_revision_id: string;
          last_observed_revision_id: string;
          current: boolean;
          last_missing_revision_id: string | null;
        }
      >
    >;
    erratumTargets?: Readonly<Record<string, NormalizedLifecycle>>;
    relationships?: Readonly<Record<string, readonly RelationshipEvidence[]>>;
    locators?: Readonly<Record<string, LocatorEvidenceCollection>>;
    cardEvidence?: Readonly<
      Record<string, readonly { source: string }[]>
    >;
    printingEvidence?: Readonly<
      Record<string, readonly { source: string }[]>
    >;
  },
): Promise<
  Record<(typeof componentDefinitions)[number][0], ExportRecordFactory>
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
        const declaredProduct =
          relationship.relationship_kind === "product"
            ? candidate.products?.find(
                (product) =>
                  product.game === card.game &&
                  (product.official_code === relationship.relationship_value ||
                    product.name === relationship.relationship_value),
              )
            : undefined;
        const declaredContext =
          relationship.relationship_kind === "distribution_context"
            ? candidate.distribution_contexts?.find(
                (context) =>
                  context.game === card.game &&
                  context.key === relationship.relationship_value,
              )
            : undefined;
        const targetId =
          relationship.relationship_kind === "product"
            ? declaredProduct?.id ??
              (await productExportId(card.game, relationship.relationship_value))
            : declaredContext?.id ??
              (await distributionContextExportId(
                card.game,
                relationship.source_lineage,
                relationship.relationship_value,
              ));
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
  const identifiedErratumRelationships = await Promise.all(
    (candidate.errata ?? []).flatMap((erratum) => {
      const observationsByLineage = new Map<string, string[]>();
      for (const provenance of erratum.provenance) {
        const observationIds =
          observationsByLineage.get(provenance.source_lineage) ?? [];
        observationIds.push(provenance.source_observation_id);
        observationsByLineage.set(
          provenance.source_lineage,
          observationIds,
        );
      }
      return [...observationsByLineage].map(
        async ([sourceLineage, sourceObservationIds]) => ({
          erratum,
          sourceLineage,
          sourceObservationIds: sourceObservationIds.sort(),
          relationshipId: `relationship_${await sha256Text(
            canonicalJson({
              kind: "erratum-target",
              erratum_id: erratum.id,
              target_type: erratum.target_type,
              target_id: erratum.target_id,
              source_lineage: sourceLineage,
            }),
          )}`,
        }),
      );
    }),
  );
  const inferredProducts =
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
            inferredProductLifecycleKey(
              card.game,
              relationship.relationship_value,
            )
          ] ?? {
            first_revision_id: relationship.first_revision_id,
            last_observed_revision_id:
              relationship.last_observed_revision_id,
            withdrawn: false,
          },
      }));
  const products = uniqueById([
    ...inferredProducts,
    ...(candidate.products ?? []).map((product) => ({
      type: "product" as const,
      id: product.id,
      game: product.game,
      official_code: product.official_code,
      name: product.name,
      lifecycle:
        lifecycles?.products?.[product.id] ?? defaultLifecycle,
    })),
  ]);
  const inferredDistributionContexts =
    identifiedRelationships
      .filter(
        ({ relationship }) =>
          relationship.relationship_kind === "distribution_context" &&
          relationship.current,
      )
      .map(({ card, relationship, targetId }) => ({
        type: "distribution_context",
        id: targetId,
        game: card.game,
        kind: "other",
        label: relationship.relationship_value,
        product_id: null,
      }));
  const distributionContexts = uniqueById([
    ...inferredDistributionContexts,
    ...(candidate.distribution_contexts ?? [])
      .filter((context) => context.observed)
      .map((context) => ({
        type: "distribution_context" as const,
        id: context.id,
        game: context.game,
        kind: context.kind,
        label: context.label,
        product_id: context.product_id,
      })),
  ]);
  const legalityRelationships = await legalityRuleRelationshipRecords(
    candidate,
    revisionId,
  );
  return {
    "supported-games": () => candidate.selected_games.map((game) => ({
        type: "supported_game",
        ...supportedGameExport(game),
      })),
    "game-profiles": () => candidate.selected_games.map((game) => ({
        type: "game_profile",
        profile: `${game}@1`,
        game,
        schema: exportedGameProfileSchema(`${game}@1`),
      })),
    cards: () => candidate.cards.map((card) => ({
      type: "card",
      ...card,
      source_lineages: [
        ...new Set(
          lifecycles?.cardEvidence?.[card.id]?.map(({ source }) => source) ??
            [],
        ),
      ].sort(),
      lifecycle: lifecycles?.cards[card.id] ?? defaultLifecycle,
    })),
    printings: () => candidate.printings.map((printing) => {
      const typed = typedPrintingProjections(
        printing.id,
        candidate.products ?? [],
        candidate.distribution_contexts ?? [],
        candidate.product_relationships ?? [],
      );
      return {
        type: "printing",
        ...printing,
        source_lineages: [
          ...new Set(
            lifecycles?.printingEvidence?.[printing.id]?.map(
              ({ source }) => source,
            ) ?? [],
          ),
        ].sort(),
        products: typed.products,
        distribution_contexts: typed.distribution_contexts,
        locator_evidence: lifecycles?.locators?.[printing.id] ?? {
          current: [],
          historical: [],
        },
        lifecycle: lifecycles?.printings[printing.id] ?? defaultLifecycle,
      };
    }),
    "printing-images": () => (candidate.printing_images ?? []).map(
      (image) => ({
        type: "printing_image",
        id: image.id,
        printing_id: image.printing_id,
        role: image.role,
        media_type: image.media_type,
        width: image.width,
        height: image.height,
        content_sha256: image.content_sha256,
        content_url:
          `/v1/printing-images/${encodeURIComponent(image.id)}/content`,
      }),
    ),
    products: () => products,
    releases: () => (candidate.products ?? [])
      .flatMap((product) =>
        product.releases.map((release) => ({
          type: "release",
          ...release,
        })),
      )
      .sort((left, right) => compareUtf8(left.id, right.id)),
    "distribution-contexts": () => distributionContexts,
    errata: () => (candidate.errata ?? [])
      .map(exportErratum)
      .sort((left, right) => compareUtf8(left.id, right.id)),
    "legality-rules": () => legalityRuleExportRecords(candidate, revisionId),
    relationships: () => uniqueById([
      ...identifiedRelationships
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
        // Legacy memberships carry only a value; their typed target IDs are
        // deterministically derived above rather than explicit source facts.
        evidence_category: "derived" as const,
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
      .filter(
        (relationship) =>
          !(candidate.product_relationships ?? []).some(
            (declared) =>
              declared.kind === relationship.kind &&
              declared.source_lineage === relationship.source_lineage &&
              canonicalJson(declared.from) ===
                canonicalJson(relationship.from) &&
              canonicalJson(declared.to) === canonicalJson(relationship.to),
          ),
      ),
      ...(candidate.product_relationships ?? []).map((relationship) => ({
        type: "relationship" as const,
        id: relationship.id,
        kind: relationship.kind,
        from: relationship.from,
        to: relationship.to,
        evidence_category: relationship.evidence_category,
        source_lineage: relationship.source_lineage,
        source_observation_ids: relationship.source_observation_ids,
        relationship_value: relationship.relationship_value,
        lifecycle:
          lifecycles?.productRelationships?.[relationship.id] ?? {
            first_revision_id: revisionId,
            last_observed_revision_id: revisionId,
            current: relationship.observed,
            last_missing_revision_id: null,
          },
      })),
      ...identifiedErratumRelationships.map(
        ({
          erratum,
          relationshipId,
          sourceLineage,
          sourceObservationIds,
        }) => {
          const lifecycle =
            lifecycles?.erratumTargets?.[
              erratumTargetLifecycleKey(erratum.id, sourceLineage)
            ] ?? defaultLifecycle;
          return {
            type: "relationship",
            id: relationshipId,
            kind: "erratum-target",
            from: { type: "erratum", id: erratum.id },
            to: {
              type: erratum.target_type,
              id: erratum.target_id,
            },
            evidence_category: "explicit",
            source_lineage: sourceLineage,
            source_observation_ids: sourceObservationIds,
            relationship_value: "effective_rules_text",
            lifecycle: {
              first_revision_id: lifecycle.first_revision_id,
              last_observed_revision_id:
                lifecycle.last_observed_revision_id,
              current: true,
              last_missing_revision_id: null,
            },
          };
        },
      ),
      ...legalityRelationships,
    ]),
  };
}

function inferredProductLifecycleKey(
  game: string,
  officialCode: string,
): string {
  return canonicalJson([game, officialCode]);
}

function uniqueById<T extends { id: string }>(values: readonly T[]): T[] {
  return [...new Map(values.map((value) => [value.id, value])).values()].sort(
    (left, right) => compareUtf8(left.id, right.id),
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
