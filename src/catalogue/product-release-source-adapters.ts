type ProductSourceGame =
  | "one-piece"
  | "fusion-world"
  | "digimon"
  | "gundam";

type DiscoveryFormat =
  | "one-piece"
  | "fusion-world"
  | "digimon"
  | "gundam";

export type OfficialRawAdapterContract = {
  adapterVersion: string;
  sourceLineage: string;
  supportedGame: ProductSourceGame;
  format: DiscoveryFormat;
  requiredSurfaces: readonly string[];
  requestPathForSurface: (surface: string) => string;
  parseBytes: (
    bytes: Uint8Array,
    context: { mediaType: string | null; url: string },
  ) => readonly unknown[];
};

const rawContractDefinitions = [
  {
    adapterVersion: "one-piece-json-document@2",
    sourceLineage: "one-piece-en",
    supportedGame: "one-piece",
    format: "one-piece",
    requiredSurfaces: [
      "card-list",
      "products",
      "releases",
      "restrictions",
      "block-policy",
      "errata",
      "don-rules",
    ],
  },
  {
    adapterVersion: "fusion-world-en@1",
    sourceLineage: "fusion-world-en",
    supportedGame: "fusion-world",
    format: "fusion-world",
    requiredSurfaces: [
      "card-search",
      "products",
      "releases",
      "legality-current",
      "legality-history",
      "errata",
    ],
  },
  {
    adapterVersion: "digimon-en@1",
    sourceLineage: "digimon-en",
    supportedGame: "digimon",
    format: "digimon",
    requiredSurfaces: [
      "card-list",
      "products",
      "releases",
      "restrictions-current",
      "restrictions-history",
      "errata",
    ],
  },
  {
    adapterVersion: "gundam-en-asia@1",
    sourceLineage: "gundam-en-asia",
    supportedGame: "gundam",
    format: "gundam",
    requiredSurfaces: [
      "packages",
      "products",
      "releases",
      "legality",
      "errata",
    ],
  },
  {
    adapterVersion: "gundam-en-us@1",
    sourceLineage: "gundam-en-us",
    supportedGame: "gundam",
    format: "gundam",
    requiredSurfaces: [
      "packages",
      "products",
      "releases",
      "legality",
      "errata",
    ],
  },
] as const;

export const officialRawAdapterContracts: readonly OfficialRawAdapterContract[] =
  Object.freeze(
    rawContractDefinitions.map((definition) =>
      Object.freeze({
        ...definition,
        requiredSurfaces: Object.freeze([...definition.requiredSurfaces]),
        requestPathForSurface: (surface: string) =>
          exactSurfacePath(
            definition.sourceLineage,
            definition.requiredSurfaces,
            surface,
          ),
        parseBytes: rawSnapshotDecoder(
          definition.format,
          definition.supportedGame,
          definition.sourceLineage,
          definition.requiredSurfaces,
        ),
      }),
    ),
  );

export function officialSourceDiscoveryRequests(
  sourceLineage: string,
  origin: string,
): readonly {
  id: string;
  method: "GET";
  url: string;
  headers: Record<string, string>;
}[] {
  const contract = officialRawAdapterContracts.find(
    (candidate) => candidate.sourceLineage === sourceLineage,
  );
  if (contract === undefined) {
    throw new Error("Official Source lineage has no discovery contract.");
  }
  const base = new URL(origin);
  return contract.requiredSurfaces.map((surface) => ({
    id: `${sourceLineage}:${surface}`,
    method: "GET",
    url: new URL(
      contract.requestPathForSurface(surface).slice(1),
      base.href.endsWith("/") ? base : new URL(`${base.href}/`),
    ).href,
    headers: {
      accept:
        surface.includes("card") ||
        surface === "packages" ||
        surface === "products"
          ? "text/html"
          : "application/json",
    },
  }));
}

function exactSurfacePath(
  sourceLineage: string,
  requiredSurfaces: readonly string[],
  surface: string,
): string {
  if (!requiredSurfaces.includes(surface)) {
    throw new Error(
      `Official Source lineage ${sourceLineage} has no ${surface} surface.`,
    );
  }
  return `/${sourceLineage}/${surface}`;
}

function rawSnapshotDecoder(
  format: DiscoveryFormat,
  game: ProductSourceGame,
  sourceLineage: string,
  requiredSurfaces: readonly string[],
): OfficialRawAdapterContract["parseBytes"] {
  return (bytes, context) => {
    const surface = surfaceFromUrl(context.url);
    if (!requiredSurfaces.includes(surface)) {
      throw new Error(
        `Official Source URL does not identify a required ${sourceLineage} surface.`,
      );
    }
    const rawDocument = decodeRawSurfacePayload(
      bytes,
      context.mediaType,
      surface,
    );
    const document = normalizeLineageSurface(
      format,
      sourceLineage,
      surface,
      rawDocument,
    );
    if (
      document.contract !== "card-keepr-official-source-surface@1" ||
      document.lineage !== sourceLineage ||
      document.surface !== surface
    ) {
      throw new Error(
        `Official Source ${surface} bytes do not satisfy the ${sourceLineage} surface binding.`,
      );
    }
    let observations: readonly unknown[];
    if (isDiscoverySurface(surface)) {
      observations = parseRawDiscoverySurface(document, format, game);
    } else if (surface === "products") {
      observations = parseRawProductsSurface(document);
    } else if (surface === "releases") {
      observations = parseRawReleasesSurface(document);
    } else {
      observations = [rawCoverageObservation(document, surface)];
    }
    return observations.map((observation, index) =>
      attachRawSurfaceEvidence(
        observation,
        sourceLineage,
        surface,
        rawDocument,
        index === 0,
      )
    );
  };
}

function normalizeLineageSurface(
  format: DiscoveryFormat,
  sourceLineage: string,
  surface: string,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const normalized =
    format === "one-piece"
      ? normalizeOnePieceSurface(surface, raw)
      : format === "fusion-world"
        ? normalizeFusionWorldSurface(surface, raw)
        : format === "digimon"
          ? normalizeDigimonSurface(surface, raw)
          : normalizeGundamSurface(sourceLineage, surface, raw);
  return {
    contract: "card-keepr-official-source-surface@1",
    lineage: sourceLineage,
    surface,
    ...normalized,
  };
}

function normalizeOnePieceSurface(
  surface: string,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  if (surface === "card-list") {
    if (raw.page !== "card-list") {
      throw new Error("One Piece card-list page identity is invalid.");
    }
    return normalizedDiscovery(
      raw.series_options,
      raw.page_info,
      normalizeOnePieceDetails(raw.card_pages),
      normalizeOnePieceProducts(raw.products),
      normalizeOnePieceReleases(raw.release_schedule),
      "recording",
    );
  }
  if (surface === "products") {
    if (raw.page !== "product-list") {
      throw new Error("One Piece Product page identity is invalid.");
    }
    return normalizedPartitions(
      normalizePartitionEntries(raw.result, normalizeOnePieceProduct),
      "recording",
    );
  }
  if (surface === "releases") {
    if (raw.publication !== "release-schedule") {
      throw new Error("One Piece Release publication identity is invalid.");
    }
    return normalizedPartitions(
      normalizePartitionEntries(raw.events, normalizeOnePieceReleaseEntry),
      "release-event",
    );
  }
  return normalizedPolicy(raw, `one-piece-${surface}`);
}

function normalizeFusionWorldSurface(
  surface: string,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  if (surface === "card-search") {
    if (raw.view !== "card-search") {
      throw new Error("Fusion World card-search view identity is invalid.");
    }
    const facets = requiredRecord(raw.facets, "Fusion World facets");
    for (const name of ["card_type", "colour", "cost"]) {
      requiredArray(facets[name], `Fusion World ${name} facet`);
    }
    return normalizedDiscovery(
      Object.entries(facets).map(([name, values]) => ({ name, values })),
      raw.result,
      normalizeFusionWorldDetails(raw.detail_pages),
      normalizeFusionWorldProducts(raw.products),
      normalizeFusionWorldReleases(raw.releases),
      "card_type=leader&colour=red&cost=1",
    );
  }
  if (surface === "products") {
    if (raw.view !== "products") {
      throw new Error("Fusion World Product view identity is invalid.");
    }
    const tabs = uniqueTextValues(raw.status_tabs, "Fusion World Product tabs");
    if (!tabs.includes("available") || !tabs.includes("coming-soon")) {
      throw new Error("Fusion World Product tabs are incomplete.");
    }
    return normalizedPartitions(
      normalizePartitionEntries(raw.result, normalizeFusionWorldProduct),
      "product-status",
    );
  }
  if (surface === "releases") {
    if (raw.publication !== "product-release-dates") {
      throw new Error("Fusion World Release publication identity is invalid.");
    }
    return normalizedPartitions(
      normalizePartitionEntries(raw.events, normalizeFusionWorldReleaseEntry),
      "release-event",
    );
  }
  return normalizedPolicy(raw, `fusion-world-${surface}`);
}

function normalizeDigimonSurface(
  surface: string,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  if (surface === "card-list") {
    if (raw.view !== "card-list") {
      throw new Error("Digimon card-list view identity is invalid.");
    }
    const filters = requiredRecord(raw.filters, "Digimon filters");
    for (const name of ["category", "cardcategory", "colour"]) {
      requiredArray(filters[name], `Digimon ${name} filter`);
    }
    return normalizedDiscovery(
      raw.version_options,
      raw.result,
      normalizeDigimonDetails(raw.card_popups),
      normalizeDigimonProducts(raw.products),
      normalizeDigimonReleases(raw.release_calendar),
      "category=all&cardcategory=digimon&colour=blue",
    );
  }
  if (surface === "products") {
    if (raw.view !== "product-index") {
      throw new Error("Digimon Product index identity is invalid.");
    }
    requiredArray(raw.tile_categories, "Digimon Product tile categories");
    return normalizedPartitions(
      normalizePartitionEntries(raw.result, normalizeDigimonProduct),
      "product-category",
    );
  }
  if (surface === "releases") {
    if (raw.publication !== "product-release-calendar") {
      throw new Error("Digimon Release publication identity is invalid.");
    }
    return normalizedPartitions(
      normalizePartitionEntries(raw.events, normalizeDigimonReleaseEntry),
      "release-event",
    );
  }
  return normalizedPolicy(raw, `digimon-${surface}`);
}

function normalizeGundamSurface(
  sourceLineage: string,
  surface: string,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const expectedLocale =
    sourceLineage === "gundam-en-asia" ? "EN-ASIA" : "EN-US";
  if (raw.locale !== expectedLocale) {
    throw new Error("Gundam surface locale does not match its Source Lineage.");
  }
  if (surface === "packages") {
    if (raw.view !== "card-search") {
      throw new Error("Gundam card-search view identity is invalid.");
    }
    return normalizedDiscovery(
      raw.package_options,
      raw.result,
      normalizeGundamDetails(raw.card_details),
      normalizeGundamProducts(raw.products),
      normalizeGundamReleases(raw.releases),
      "package=all",
    );
  }
  if (surface === "products") {
    if (raw.view !== "product-list") {
      throw new Error("Gundam Product list identity is invalid.");
    }
    return normalizedPartitions(
      normalizePartitionEntries(raw.result, normalizeGundamProduct),
      "package",
    );
  }
  if (surface === "releases") {
    if (raw.publication !== "locale-product-release-dates") {
      throw new Error("Gundam Release publication identity is invalid.");
    }
    return normalizedPartitions(
      normalizePartitionEntries(raw.events, normalizeGundamReleaseEntry),
      "release-event",
    );
  }
  return normalizedPolicy(raw, `gundam-${surface}`);
}

function normalizedDiscovery(
  discoveredVocabulary: unknown,
  partition: unknown,
  details: unknown,
  products: unknown,
  releases: unknown,
  bucket: string,
): Record<string, unknown> {
  const page = requiredRecord(partition, "Official Source result");
  if (page.cap_signal !== undefined && page.cap_signal !== null) {
    throw new Error(
      "Official Source partition result-cap evidence does not prove complete coverage.",
    );
  }
  const partitions = requiredArray(
    page.partitions,
    "Official Source partitions",
  );
  if (
    partitions.length === 0 ||
    partitions.some(
      (value) =>
        requiredRecord(value, "Official Source partition").bucket !== bucket,
    )
  ) {
    throw new Error(
      "Official Source discovered partition closure does not match the exact surface contract.",
    );
  }
  return {
    source_buckets: [bucket],
    facets: requiredArray(
      discoveredVocabulary,
      "Official Source discovered vocabulary",
    ),
    partitions,
    details: requiredArray(details, "Official Source details"),
    products: requiredArray(products, "Official Source Products"),
    releases: requiredArray(releases, "Official Source Releases"),
  };
}

function normalizedPartitions(
  value: unknown,
  bucket: string,
): Record<string, unknown> {
  const result = requiredRecord(value, "Official Source partition result");
  if (result.cap_signal !== undefined && result.cap_signal !== null) {
    throw new Error(
      "Official Source partition result-cap evidence does not prove complete coverage.",
    );
  }
  return {
    partitions: requiredArray(
      result.partitions,
      `Official Source ${bucket} partitions`,
    ),
  };
}

function normalizedPolicy(
  raw: Record<string, unknown>,
  expectedPublication: string,
): Record<string, unknown> {
  if (raw.publication !== expectedPublication) {
    throw new Error("Official policy publication identity is invalid.");
  }
  return {
    revision: requiredText(raw.revision, "Official policy revision"),
    entries: requiredArray(raw.entries, "Official policy entries"),
  };
}

function normalizePartitionEntries(
  value: unknown,
  entry: (value: unknown) => unknown,
): Record<string, unknown> {
  const result = requiredRecord(value, "Official Source partition result");
  return {
    ...result,
    partitions: requiredArray(
      result.partitions,
      "Official Source partitions",
    ).map((rawPage) => {
      const page = requiredRecord(rawPage, "Official Source partition");
      return {
        ...page,
        entries: requiredArray(
          page.entries,
          "Official Source partition entries",
        ).map(entry),
      };
    }),
  };
}

function normalizeOnePieceDetails(value: unknown): unknown[] {
  return requiredArray(value, "One Piece Card pages").map((item) => {
    const card = requiredRecord(item, "One Piece Card page");
    return canonicalDetail(card, {
      path: "source_record_id",
      number: "card_number",
      title: "name",
      rules: "Effect",
      attributes: {
        card_type: card.Category,
        colours: card.Color,
        cost: card.Cost,
        life: card.Life,
        battle_attributes: card.Attribute,
        power: card.Power,
        counter: card.Counter,
        traits: card.Type,
        block_icons: card["Block icon"],
        effect_text: card.Effect,
        trigger_text: card.Trigger,
      },
      imageFields: [{ role: "front", value: card.image_url }],
    });
  });
}

function normalizeFusionWorldDetails(value: unknown): unknown[] {
  return requiredArray(value, "Fusion World Card details").map((item) => {
    const card = requiredRecord(item, "Fusion World Card detail");
    const images = requiredArray(
      card.image_urls,
      "Fusion World Card images",
    ).map((image) => {
      const record = requiredRecord(image, "Fusion World Card image");
      return {
        role: requiredText(record.role, "Fusion World image role"),
        value: record.url,
      };
    });
    if (
      card.card_type === "leader" &&
      (
        images.length !== 2 ||
        new Set(images.map(({ role }) => role)).size !== 2 ||
        !images.some(({ role }) => role === "front") ||
        !images.some(({ role }) => role === "back")
      )
    ) {
      throw new Error(
        "Fusion World Leader requires exact front and back image roles.",
      );
    }
    return canonicalDetail(card, {
      path: "detail_path",
      number: "card_number",
      title: "name",
      rules: "skills_text",
      attributes: {
        card_type: card.card_type,
        colours: card.color,
        cost: card.cost,
        specified_cost: card.specified_cost,
        power: card.power,
        combo_power: card.combo_power,
        traits: card.special_traits,
        skills: card.skills,
        ...(card.leader_faces === undefined
          ? {}
          : { leader_faces: card.leader_faces }),
      },
      imageFields: images,
    });
  });
}

function normalizeDigimonDetails(value: unknown): unknown[] {
  return requiredArray(value, "Digimon Card popups").map((item) => {
    const card = requiredRecord(item, "Digimon Card popup");
    return canonicalDetail(card, {
      path: "popup_id",
      number: "card_number",
      title: "name",
      rules: "Effect",
      attributes: {
        card_type: card.cardcategory,
        colours: card.Color,
        level: card.Lv,
        play_cost: card["Play Cost"],
        use_cost: card["Use Cost"],
        dp: card.DP,
        form: card.Form,
        attribute: card.Attribute,
        traits: card.Type,
        digivolution_requirements: card["Digivolution Cost"],
        text_sections: card.text_sections,
        dual_colours: card["DUAL Color"],
        dual_cost: card["DUAL Cost"],
        link_dp: card["Link DP"],
      },
      imageFields: [{ role: "front", value: card.image_url }],
    });
  });
}

function normalizeGundamDetails(value: unknown): unknown[] {
  return requiredArray(value, "Gundam Card details").map((item) => {
    const card = requiredRecord(item, "Gundam Card detail");
    return canonicalDetail(card, {
      path: "detailSearch",
      number: "card_number",
      title: "name",
      rules: "Effect",
      attributes: {
        card_type: card.Type,
        colours: card.Color,
        level: card.Level,
        cost: card.Cost,
        block_icon: card.Block,
        effect_text: card.Effect,
        zone: card.Zone,
        traits: card.Trait,
        link_condition: card.Link,
        ap: card.AP,
        hp: card.HP,
        series_titles: card.Title,
      },
      imageFields: [{ role: "front", value: card.image_url }],
    });
  });
}

function canonicalDetail(
  raw: Record<string, unknown>,
  mapping: {
    path: string;
    number: string;
    title: string;
    rules: string;
    attributes: Record<string, unknown>;
    imageFields: readonly { role: string; value: unknown }[];
  },
): Record<string, unknown> {
  const printing =
    raw.printing === undefined
      ? undefined
      : requiredRecord(raw.printing, "Official Printing fields");
  const images =
    printing === undefined
      ? []
      : mapping.imageFields.map(({ role, value }) => ({
          role,
          source_url: requiredText(value, "Official Printing image URL"),
          artwork_fingerprint: requiredText(
            raw.artwork_fingerprint,
            "Official artwork fingerprint",
          ),
        }));
  return {
    path: requiredText(raw[mapping.path], "Official Card locator"),
    number: requiredText(raw[mapping.number], "Official Card number"),
    title: requiredText(raw[mapping.title], "Official Card name"),
    rules: requiredText(raw[mapping.rules], "Official Card rules"),
    profile: requiredText(raw.profile, "Official Game Profile"),
    attributes: mapping.attributes,
    product_codes: requiredTextArray(
      raw.product_codes,
      "Official Product codes",
    ),
    distribution: requiredRecord(
      raw.distribution,
      "Official Distribution",
    ),
    ...(printing === undefined
      ? {}
      : {
          printing: {
            rarity: printing.rarity ?? null,
            normalizedRarity: printing.normalized_rarity ?? null,
            attributes: printing.attributes ?? {},
          },
          printed_rules: requiredText(
            raw.printed_rules,
            "Official printed rules",
          ),
          variant: requiredText(raw.variant, "Official Printing variant"),
          artwork_fingerprint: requiredText(
            raw.artwork_fingerprint,
            "Official artwork fingerprint",
          ),
          printed_fields_digest: requiredText(
            raw.printed_fields_digest,
            "Official printed fields digest",
          ),
          image: images[0]!.source_url,
          images,
        }),
  };
}

function normalizeOnePieceProducts(value: unknown): unknown[] {
  return requiredArray(value, "One Piece Products").map(
    normalizeOnePieceProduct,
  );
}

function normalizeFusionWorldProducts(value: unknown): unknown[] {
  return requiredArray(value, "Fusion World Products").map(
    normalizeFusionWorldProduct,
  );
}

function normalizeDigimonProducts(value: unknown): unknown[] {
  return requiredArray(value, "Digimon Products").map(
    normalizeDigimonProduct,
  );
}

function normalizeGundamProducts(value: unknown): unknown[] {
  return requiredArray(value, "Gundam Products").map(
    normalizeGundamProduct,
  );
}

function normalizeOnePieceProduct(value: unknown): Record<string, unknown> {
  const product = requiredRecord(value, "One Piece Product");
  return canonicalProduct(product, "product_code", "product_name");
}

function normalizeFusionWorldProduct(value: unknown): Record<string, unknown> {
  const product = requiredRecord(value, "Fusion World Product");
  return canonicalProduct(product, "productCode", "productName");
}

function normalizeDigimonProduct(value: unknown): Record<string, unknown> {
  const product = requiredRecord(value, "Digimon Product");
  return canonicalProduct(product, "productId", "productTitle");
}

function normalizeGundamProduct(value: unknown): Record<string, unknown> {
  const product = requiredRecord(value, "Gundam Product");
  return canonicalProduct(product, "productCode", "productName");
}

function canonicalProduct(
  product: Record<string, unknown>,
  codeField: string,
  nameField: string,
): Record<string, unknown> {
  return {
    code: requiredText(product[codeField], "Official Product code"),
    title: requiredText(product[nameField], "Official Product name"),
    ...(product.distribution === undefined
      ? {}
      : { distribution: product.distribution }),
    ...Object.fromEntries(
      Object.entries(product).filter(([field]) =>
        field !== codeField &&
        field !== nameField &&
        field !== "distribution"
      ),
    ),
  };
}

function normalizeOnePieceReleases(value: unknown): unknown[] {
  return requiredArray(value, "One Piece Releases").map((item) =>
    canonicalRelease(requiredRecord(item, "One Piece Release"), {
      code: "product_code",
      event: "announcement_id",
    })
  );
}

function normalizeFusionWorldReleases(value: unknown): unknown[] {
  return requiredArray(value, "Fusion World Releases").map((item) =>
    canonicalRelease(requiredRecord(item, "Fusion World Release"), {
      code: "productCode",
      event: "releaseId",
    })
  );
}

function normalizeDigimonReleases(value: unknown): unknown[] {
  return requiredArray(value, "Digimon Releases").map((item) =>
    canonicalRelease(requiredRecord(item, "Digimon Release"), {
      code: "productId",
      event: "calendarEntryId",
    })
  );
}

function normalizeGundamReleases(value: unknown): unknown[] {
  return requiredArray(value, "Gundam Releases").map((item) =>
    canonicalRelease(requiredRecord(item, "Gundam Release"), {
      code: "productCode",
      event: "releaseEventId",
    })
  );
}

function normalizeOnePieceReleaseEntry(value: unknown): unknown {
  return canonicalReleaseEntry(value, normalizeOnePieceProduct, (release) =>
    canonicalRelease(release, {
      code: "product_code",
      event: "announcement_id",
    }));
}

function normalizeFusionWorldReleaseEntry(value: unknown): unknown {
  return canonicalReleaseEntry(value, normalizeFusionWorldProduct, (release) =>
    canonicalRelease(release, {
      code: "productCode",
      event: "releaseId",
    }));
}

function normalizeDigimonReleaseEntry(value: unknown): unknown {
  return canonicalReleaseEntry(value, normalizeDigimonProduct, (release) =>
    canonicalRelease(release, {
      code: "productId",
      event: "calendarEntryId",
    }));
}

function normalizeGundamReleaseEntry(value: unknown): unknown {
  return canonicalReleaseEntry(value, normalizeGundamProduct, (release) =>
    canonicalRelease(release, {
      code: "productCode",
      event: "releaseEventId",
    }));
}

function canonicalReleaseEntry(
  value: unknown,
  product: (value: unknown) => Record<string, unknown>,
  release: (value: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
  const entry = requiredRecord(value, "Official Release entry");
  return {
    product: product(entry.product),
    release: release(
      requiredRecord(entry.release, "Official Release facts"),
    ),
  };
}

function canonicalRelease(
  release: Record<string, unknown>,
  fields: { code: string; event: string },
): Record<string, unknown> {
  return {
    code: requiredText(release[fields.code], "Official Release Product code"),
    event_key: requiredText(release[fields.event], "Official Release identity"),
    region: release.region,
    precision: release.precision,
    date: release.date,
    status: release.status,
  };
}

function attachRawSurfaceEvidence(
  observation: unknown,
  sourceLineage: string,
  surface: string,
  document: Record<string, unknown>,
  retainDocument: boolean,
): Record<string, unknown> {
  const record = requiredRecord(
    observation,
    `Official Source ${surface} observation`,
  );
  const existing =
    record.source_sidecar === undefined
      ? {}
      : requiredRecord(record.source_sidecar, "Source sidecar");
  const raw =
    existing.raw === undefined
      ? {}
      : requiredRecord(existing.raw, "Source sidecar raw fields");
  const consumed = Array.isArray(existing.consumed_fields)
    ? existing.consumed_fields
    : [];
  const unmapped = Array.isArray(existing.unmapped_optional_fields)
    ? existing.unmapped_optional_fields
      : [];
  const mappedRootFields = mappedSurfaceFields(sourceLineage, surface);
  return {
    ...record,
    source_sidecar: {
      ...existing,
      raw: {
        ...raw,
        official_surfaces: [
          ...(
            Array.isArray(raw.official_surfaces)
              ? raw.official_surfaces
              : []
          ),
          {
            source_lineage: sourceLineage,
            surface,
            ...(retainDocument
              ? { document }
              : { retained_by_observation_ordinal: 1 }),
          },
        ],
      },
      consumed_fields: [
        ...new Set([
          ...consumed,
          "source_sidecar.raw.official_surfaces[].source_lineage",
          "source_sidecar.raw.official_surfaces[].surface",
          ...(retainDocument ? mappedRootFields : []).map(
            (field) =>
              `source_sidecar.raw.official_surfaces[0].document.${field}`,
          ),
        ]),
      ].sort(),
      unmapped_optional_fields: [
        ...unmapped,
        ...(retainDocument ? Object.entries(document) : [])
          .filter(([field]) => !mappedRootFields.includes(field))
          .map(([field, value]) => ({
            path:
              `source_sidecar.raw.official_surfaces[0].document.${field}`,
            value,
          })),
      ],
    },
  };
}

function mappedSurfaceFields(
  sourceLineage: string,
  surface: string,
): string[] {
  if (isDiscoverySurface(surface)) {
    if (sourceLineage === "one-piece-en") {
      return [
        "page",
        "series_options",
        "page_info",
        "card_pages",
        "products",
        "release_schedule",
      ];
    }
    if (sourceLineage === "fusion-world-en") {
      return [
        "view",
        "facets",
        "result",
        "detail_pages",
        "products",
        "releases",
      ];
    }
    if (sourceLineage === "digimon-en") {
      return [
        "view",
        "version_options",
        "filters",
        "result",
        "card_popups",
        "products",
        "release_calendar",
      ];
    }
    return [
      "view",
      "locale",
      "package_options",
      "result",
      "card_details",
      "products",
      "releases",
    ];
  }
  if (surface === "products") {
    return sourceLineage === "one-piece-en"
      ? ["page", "series_options", "result"]
      : sourceLineage === "fusion-world-en"
        ? ["view", "status_tabs", "result"]
        : sourceLineage === "digimon-en"
          ? ["view", "tile_categories", "result"]
          : ["view", "locale", "result"];
  }
  if (surface === "releases") {
    return sourceLineage.startsWith("gundam-")
      ? ["publication", "locale", "events"]
      : ["publication", "events"];
  }
  return sourceLineage.startsWith("gundam-")
    ? ["publication", "locale", "revision", "entries"]
    : ["publication", "revision", "entries"];
}

function decodeRawSurfacePayload(
  bytes: Uint8Array,
  mediaType: string | null,
  surface: string,
): Record<string, unknown> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(bytes);
  } catch {
    throw new Error(`Official Source ${surface} bytes are not valid UTF-8.`);
  }
  const normalizedMediaType = mediaType?.split(";", 1)[0]?.trim().toLowerCase();
  let json: string;
  if (
    isDiscoverySurface(surface) ||
    surface === "products"
  ) {
    if (normalizedMediaType !== "text/html") {
      throw new Error(
        `Official Source ${surface} must be captured as text/html.`,
      );
    }
    const matches = [
      ...text.matchAll(
        /<script\s+type=["']application\/json["']\s+data-keepr-official-payload(?:=["'][^"']*["'])?\s*>([\s\S]*?)<\/script>/giu,
      ),
    ];
    if (matches.length !== 1) {
      throw new Error(
        `Official Source ${surface} HTML must contain exactly one official payload.`,
      );
    }
    json = matches[0]![1]!;
  } else {
    if (
      normalizedMediaType !== "application/json" &&
      normalizedMediaType !== "application/ld+json"
    ) {
      throw new Error(
        `Official Source ${surface} must be captured as application/json.`,
      );
    }
    json = text;
  }
  try {
    return requiredRecord(
      JSON.parse(json),
      `Official Source ${surface} payload`,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Official Source")
    ) {
      throw error;
    }
    throw new Error(`Official Source ${surface} payload is not valid JSON.`);
  }
}

function parseRawDiscoverySurface(
  surface: Record<string, unknown>,
  format: DiscoveryFormat,
  game: ProductSourceGame,
): readonly unknown[] {
  const sourceBuckets = uniqueTextValues(
    surface.source_buckets,
    "Official Source discovery buckets",
  );
  if (sourceBuckets.length === 0) {
    throw new Error("Official Source discovery buckets are incomplete.");
  }
  const facets = requiredArray(
    surface.facets,
    "Official Source discovery facets",
  );
  if (facets.length === 0) {
    throw new Error("Official Source discovery facets are incomplete.");
  }
  const entries = completePartitionEntries(surface.partitions);
  const details = requiredArray(
    surface.details,
    "Official Source Card details",
  );
  const products = requiredArray(
    surface.products,
    "Official Source referenced Products",
  );
  const releases = requiredArray(
    surface.releases,
    "Official Source referenced Releases",
  );
  const keys = surfaceKeys[format];
  return parseOfficialDiscovery(
    {
      [keys.listing]: {
        page: 1,
        pages: 1,
        total: entries.length,
        has_next: false,
        entries,
      },
      [keys.details]: details,
      [keys.products]: products,
      [keys.releases]: releases,
      [keys.legality]: {
        revision: "captured-by-required-policy-surfaces",
        entries: [],
      },
      [keys.errata]: {
        revision: "captured-by-required-policy-surfaces",
        entries: [],
      },
    },
    keys,
    game,
  ).map((observation) => {
    const record = requiredRecord(
      observation,
      "Official discovery observation",
    );
    const memberships =
      record.memberships === undefined
        ? {
            products: [],
            distribution_contexts: [],
            source_buckets: [],
          }
        : requiredRecord(
            record.memberships,
            "Official discovery memberships",
          );
    return {
      ...record,
      memberships: {
        ...memberships,
        source_buckets: sourceBuckets,
      },
    };
  });
}

function parseRawProductsSurface(
  surface: Record<string, unknown>,
): readonly unknown[] {
  const products = completePartitionEntries(surface.partitions)
    .map((value) => requiredRecord(value, "Official Source Product"));
  const releasesByCode = new Map<string, Record<string, unknown>[]>();
  const policy = {
    revision: "captured-by-required-policy-surfaces",
    entries: [],
  };
  return products.map((product) =>
    productOnlyObservation(product, releasesByCode, policy, policy)
  );
}

function parseRawReleasesSurface(
  surface: Record<string, unknown>,
): readonly unknown[] {
  const entries = completePartitionEntries(surface.partitions)
    .map((value) => requiredRecord(value, "Official Source Release entry"));
  const products = new Map<string, Record<string, unknown>>();
  const releases = new Map<string, Record<string, unknown>[]>();
  for (const entry of entries) {
    const product = requiredRecord(
      entry.product,
      "Official Source Release Product",
    );
    const code = requiredText(product.code, "Official Release Product code");
    const release = requiredRecord(
      entry.release,
      "Official Source Release value",
    );
    if (requiredText(release.code, "Official Release code") !== code) {
      throw new Error(
        "Official Source Release Product binding is inconsistent.",
      );
    }
    products.set(code, product);
    releases.set(code, [...(releases.get(code) ?? []), release]);
  }
  const policy = {
    revision: "captured-by-required-policy-surfaces",
    entries: [],
  };
  return [...products.entries()].map(([code, product]) =>
    productOnlyObservation(
      product,
      new Map([[code, releases.get(code) ?? []]]),
      policy,
      policy,
    )
  );
}

function rawCoverageObservation(
  surface: Record<string, unknown>,
  name: string,
): Record<string, unknown> {
  requiredText(surface.revision, `Official Source ${name} revision`);
  requiredArray(surface.entries, `Official Source ${name} entries`);
  return {
    completeness: completeObservation(),
    product_release_catalogue: {
      products: [],
      distribution_contexts: [],
      relationships: [],
    },
  };
}

function completePartitionEntries(value: unknown): unknown[] {
  const pages = requiredArray(
    value,
    "Official Source discovery partitions",
  ).map((item) =>
    requiredRecord(item, "Official Source discovery partition page")
  );
  if (pages.length === 0) {
    throw new Error("Official Source discovery partitions are incomplete.");
  }
  const byBucket = new Map<string, Record<string, unknown>[]>();
  for (const page of pages) {
    if (Object.hasOwn(page, "result_cap")) {
      throw new Error(
        "Official Source partition result-cap evidence does not prove complete coverage.",
      );
    }
    const bucket = requiredText(
      page.bucket,
      "Official Source partition bucket",
    );
    byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), page]);
  }
  const allEntries: unknown[] = [];
  for (const [bucket, bucketPages] of byBucket) {
    bucketPages.sort(
      (left, right) =>
        requiredPositiveInteger(left.page, "Official Source page") -
        requiredPositiveInteger(right.page, "Official Source page"),
    );
    const pageCount = requiredPositiveInteger(
      bucketPages[0]!.pages,
      "Official Source page count",
    );
    if (
      bucketPages.length !== pageCount ||
      bucketPages.some(
        (page, index) =>
          page.bucket !== bucket ||
          page.page !== index + 1 ||
          page.pages !== pageCount ||
          page.has_next !== (index + 1 < pageCount),
      )
    ) {
      throw new Error(
        "Official Source pagination evidence does not prove complete partitions.",
      );
    }
    const entries = bucketPages.flatMap((page) =>
      requiredArray(page.entries, "Official Source partition entries")
    );
    const declaredTotal = requiredNonNegativeInteger(
      bucketPages[0]!.total,
      "Official Source partition total",
    );
    if (
      entries.length !== declaredTotal ||
      bucketPages.some((page) => page.total !== declaredTotal)
    ) {
      throw new Error(
        "Official Source count evidence does not prove complete partitions.",
      );
    }
    allEntries.push(...entries);
  }
  return allEntries;
}

function surfaceFromUrl(value: string): string {
  const pathname = new URL(value).pathname.replace(/\/+$/u, "");
  return decodeURIComponent(pathname.slice(pathname.lastIndexOf("/") + 1));
}

function isDiscoverySurface(surface: string): boolean {
  return surface === "card-list" ||
    surface === "card-search" ||
    surface === "packages";
}

function uniqueTextValues(value: unknown, name: string): string[] {
  const result = requiredArray(value, name).map((item) =>
    requiredText(item, name)
  );
  if (new Set(result).size !== result.length) {
    throw new Error(`${name} overlap.`);
  }
  return result;
}

function requiredPositiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new Error(`${name} is invalid.`);
  }
  return Number(value);
}

function requiredNonNegativeInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(`${name} is invalid.`);
  }
  return Number(value);
}

const surfaceKeys = {
  "one-piece": {
    listing: "card_list",
    details: "card_pages",
    products: "product_catalog",
    releases: "release_schedule",
    legality: "rules_restrictions",
    errata: "correction_notices",
  },
  "fusion-world": {
    listing: "search",
    details: "detail_pages",
    products: "products",
    releases: "releases",
    legality: "banned_limited",
    errata: "errata_notices",
  },
  digimon: {
    listing: "card_index",
    details: "card_details",
    products: "product_index",
    releases: "release_calendar",
    legality: "restricted_cards",
    errata: "errata_notices",
  },
  gundam: {
    listing: "card_search",
    details: "card_details",
    products: "product_list",
    releases: "release_list",
    legality: "regulation",
    errata: "errata",
  },
} as const;

export function officialDiscoveryAdapter(
  format: DiscoveryFormat,
  game: ProductSourceGame,
): (document: unknown) => readonly unknown[] {
  return (document) => parseOfficialDiscovery(document, surfaceKeys[format], game);
}

function parseOfficialDiscovery(
  document: unknown,
  keys: (typeof surfaceKeys)[DiscoveryFormat],
  game: ProductSourceGame,
): readonly unknown[] {
  const root = requiredRecord(document, "Official discovery document");
  const listing = requiredRecord(root[keys.listing], `Official ${keys.listing}`);
  const details = requiredArray(root[keys.details], `Official ${keys.details}`)
    .map((value) => requiredRecord(value, "Official Card detail"));
  const products = requiredArray(root[keys.products], `Official ${keys.products}`)
    .map((value) => requiredRecord(value, "Official Product"));
  const releases = requiredArray(root[keys.releases], `Official ${keys.releases}`)
    .map((value) => requiredRecord(value, "Official Release"));
  const legality = requiredSurface(root[keys.legality], keys.legality);
  const errata = requiredSurface(root[keys.errata], keys.errata);
  const entries = requiredArray(listing.entries, "Official listing entries")
    .map((value) => requiredRecord(value, "Official listing entry"));

  if (
    listing.page !== 1 ||
    listing.pages !== 1 ||
    listing.has_next !== false ||
    listing.total !== entries.length ||
    Object.hasOwn(listing, "result_cap")
  ) {
    throw new Error(
      "Official listing pagination/count/cap evidence does not prove complete coverage.",
    );
  }
  if (details.length !== entries.length) {
    throw new Error(
      "Official listing/detail partitions do not prove complete coverage.",
    );
  }
  const detailPaths = uniqueRequiredText(details, "path", "Card detail path");
  const listingPaths = uniqueRequiredText(entries, "detail", "listing detail path");
  if (
    detailPaths.length !== listingPaths.length ||
    detailPaths.some((path, index) => path !== [...listingPaths].sort()[index])
  ) {
    throw new Error(
      "Official listing/detail discovery surfaces are incomplete or overlap.",
    );
  }
  const productsByCode = new Map(
    products.map((product) => [
      requiredText(product.code, "Official Product code"),
      product,
    ]),
  );
  if (productsByCode.size !== products.length) {
    throw new Error("Official Product partitions overlap.");
  }
  const releasesByCode = new Map<string, Record<string, unknown>[]>();
  for (const release of releases) {
    const code = requiredText(release.code, "Official Release Product code");
    if (!productsByCode.has(code)) {
      throw new Error("Official Release references an undiscovered Product.");
    }
    releasesByCode.set(code, [...(releasesByCode.get(code) ?? []), release]);
  }

  const observedProductCodes = new Set<string>();
  const observations = details.map((detail) => {
    const productCodes = requiredTextArray(
      detail.product_codes,
      "Official Card Product codes",
    );
    productCodes.forEach((code) => {
      if (!productsByCode.has(code)) {
        throw new Error("Official Card detail references an undiscovered Product.");
      }
      observedProductCodes.add(code);
    });
    return cardObservation(
      detail,
      productCodes.map((code) => productsByCode.get(code)!),
      releasesByCode,
      legality,
      errata,
      game,
    );
  });
  observations.push(
    ...products
      .filter((product) =>
        !observedProductCodes.has(requiredText(product.code, "Product code"))
      )
      .map((product) =>
        productOnlyObservation(product, releasesByCode, legality, errata)
      ),
  );
  return observations;
}

function cardObservation(
  detail: Record<string, unknown>,
  products: Record<string, unknown>[],
  releasesByCode: Map<string, Record<string, unknown>[]>,
  legality: Record<string, unknown>,
  errata: Record<string, unknown>,
  game: ProductSourceGame,
): Record<string, unknown> {
  const distribution = requiredRecord(
    detail.distribution,
    "Official Distribution",
  );
  const distributionCode = requiredText(
    distribution.code,
    "Official Distribution code",
  );
  const distributionProductReference =
    distribution.product_reference === undefined
      ? null
      : productReferenceValue(
          distribution.product_reference,
          "Official Distribution Product reference",
        );
  if (
    distributionProductReference !== null &&
    !products.some(
      (product) =>
        productReferenceKey(productReference(product)) ===
        productReferenceKey(distributionProductReference),
    )
  ) {
    throw new Error(
      "Official Distribution references a Product not evidenced by the Card detail.",
    );
  }
  const productCatalogue = catalogue(products, releasesByCode);
  const relationships: Record<string, unknown>[] = products.flatMap((product) => {
    const reference = productReference(product);
    return [
      ...(detail.printing === undefined
        ? []
        : [{
            kind: "printing-product",
            product_reference: reference,
            evidence_category: "explicit",
            resolution: "explicit",
          }]),
      {
        kind: "product-card",
        product_reference: reference,
        card_reference: { kind: "current_card" },
        evidence_category: "explicit",
        resolution: "explicit",
      },
    ];
  });
  if (detail.printing !== undefined) {
    relationships.push({
      kind: "printing-distribution-context",
      context_key: distributionCode,
      evidence_category: "derived",
      resolution: "deterministic",
    });
  }
  if (distributionProductReference !== null) {
    relationships.push({
      kind: "distribution-context-product",
      context_key: distributionCode,
      product_reference: distributionProductReference,
      evidence_category: "explicit",
      resolution: "explicit",
    });
  } else if (typeof distribution.product_label === "string") {
    relationships.push({
      kind: "distribution-context-product",
      context_key: distributionCode,
      product_reference: {
        kind: "name",
        value: requiredText(
          distribution.product_label,
          "Official Distribution Product label",
        ),
      },
      evidence_category: "explicit",
      resolution: "warning",
    });
  }
  const artwork = detail.artwork_fingerprint;
  return {
    completeness: completeObservation(),
    card: {
      game,
      official_identity: {
        kind: "card_number",
        value: requiredText(detail.number, "Official Card number"),
      },
      name: requiredText(detail.title, "Official Card title"),
      effective_rules_text: requiredText(detail.rules, "Official Card rules"),
      game_data: {
        profile: requiredText(detail.profile, "Official Card profile"),
        attributes: detail.attributes,
      },
    },
    ...(detail.printing === undefined
      ? {}
      : {
          printing: {
            rarity: {
              raw: nullableText(
                requiredRecord(detail.printing, "Official Printing").rarity,
                "Official Printing rarity",
              ),
              normalized: nullableText(
                requiredRecord(detail.printing, "Official Printing")
                  .normalizedRarity,
                "Official normalized rarity",
              ),
            },
            printed_rules_text: requiredText(
              detail.printed_rules,
              "Official printed rules",
            ),
            game_data: {
              profile: requiredText(detail.profile, "Official Card profile"),
              attributes: requiredRecord(
                detail.printing,
                "Official Printing",
              ).attributes,
            },
          },
          identity_evidence: {
            locator: requiredText(detail.path, "Official Card path"),
            variant_key: requiredText(detail.variant, "Official variant"),
            artwork_fingerprint: requiredText(
              artwork,
              "Official artwork fingerprint",
            ),
            printed_fields_digest: requiredText(
              detail.printed_fields_digest,
              "Official printed fields digest",
            ),
            treatment: "standard",
            demonstrably_novel: true,
            novelty_basis: {
              kind: "official_printing_image",
              source_url: requiredText(detail.image, "Official image URL"),
              artwork_fingerprint: artwork,
            },
          },
          appearance_evidence: {
            images:
              detail.images === undefined
                ? [{
                    role: "front",
                    source_url: detail.image,
                    artwork_fingerprint: artwork,
                  }]
                : requiredArray(
                    detail.images,
                    "Official Printing images",
                  ),
          },
        }),
    memberships: {
      products: [],
      distribution_contexts: [],
      source_buckets: [],
    },
    product_release_catalogue: {
      ...productCatalogue,
      distribution_contexts: [{
        key: distributionCode,
        kind: distribution.kind,
        label: distribution.label,
        ...(distributionProductReference === null
          ? {}
          : { product_reference: distributionProductReference }),
        evidence_category: "explicit",
      }],
      relationships,
    },
    source_sidecar: sourceSidecar(detail, products, legality, errata),
  };
}

function productOnlyObservation(
  product: Record<string, unknown>,
  releasesByCode: Map<string, Record<string, unknown>[]>,
  legality: Record<string, unknown>,
  errata: Record<string, unknown>,
): Record<string, unknown> {
  const distribution =
    product.distribution === undefined
      ? null
      : requiredRecord(product.distribution, "Official Product Distribution");
  const contextKey =
    distribution === null
      ? null
      : requiredText(distribution.code, "Official Distribution code");
  return {
    completeness: completeObservation(),
    product_release_catalogue: {
      ...catalogue([product], releasesByCode),
      distribution_contexts:
        distribution === null
          ? []
          : [{
              key: contextKey,
              kind: distribution.kind,
              label: distribution.label,
              product_reference: productReference(product),
              evidence_category: "explicit",
            }],
      relationships:
        distribution === null
          ? []
          : [{
              kind: "distribution-context-product",
              context_key: contextKey,
              product_reference: productReference(product),
              evidence_category: "explicit",
              resolution: "explicit",
            }],
    },
    source_sidecar: sourceSidecar(null, [product], legality, errata),
  };
}

function catalogue(
  products: Record<string, unknown>[],
  releasesByCode: Map<string, Record<string, unknown>[]>,
) {
  return {
    products: products.map((product) => {
      const code = requiredText(product.code, "Official Product code");
      return {
        reference: productReference(product),
        official_code: code,
        name: requiredText(product.title, "Official Product title"),
        releases: (releasesByCode.get(code) ?? []).map((release) => ({
          event_key: release.event_key,
          region: release.region,
          date: { precision: release.precision, value: release.date },
          status: release.status,
        })),
      };
    }),
    distribution_contexts: [],
    relationships: [],
  };
}

function sourceSidecar(
  detail: Record<string, unknown> | null,
  products: Record<string, unknown>[],
  legality: Record<string, unknown>,
  errata: Record<string, unknown>,
) {
  return {
    raw: { detail, products, legality, errata },
    consumed_fields: [
      "detail.number",
      "detail.title",
      "detail.rules",
      "products[].code",
      "products[].title",
    ],
    unmapped_optional_fields: products.flatMap((product, index) =>
      product.campaign_note === undefined
        ? []
        : [{
            path: `source_sidecar.raw.products[${index}].campaign_note`,
            value: product.campaign_note,
          }]
    ),
  };
}

function requiredSurface(value: unknown, name: string) {
  const surface = requiredRecord(value, `Official ${name}`);
  requiredText(surface.revision, `Official ${name} revision`);
  requiredArray(surface.entries, `Official ${name} entries`);
  return surface;
}

function completeObservation() {
  return {
    structurally_complete: true,
    required_surfaces_complete: true,
    partitions_complete: true,
    declared_record_count: 1,
    parsed_record_count: 1,
  };
}

function productReference(
  product: Record<string, unknown>,
): { kind: "official_code"; value: string } {
  return {
    kind: "official_code",
    value: requiredText(product.code, "Official Product code"),
  };
}

function productReferenceValue(
  value: unknown,
  name: string,
): { kind: "official_code" | "name"; value: string } {
  const reference = requiredRecord(value, name);
  if (reference.kind !== "official_code" && reference.kind !== "name") {
    throw new Error(`${name} kind is invalid.`);
  }
  return {
    kind: reference.kind,
    value: requiredText(reference.value, `${name} value`),
  };
}

function productReferenceKey(reference: {
  kind: "official_code" | "name";
  value: string;
}): string {
  return `${reference.kind}:${reference.value}`;
}

function uniqueRequiredText(
  values: Record<string, unknown>[],
  field: string,
  name: string,
): string[] {
  const result = values.map((value) => requiredText(value[field], name)).sort();
  if (new Set(result).size !== result.length) {
    throw new Error(`Official ${name} values overlap.`);
  }
  return result;
}

function requiredRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function requiredArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} is invalid.`);
  return value;
}

function requiredTextArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${name} is invalid.`);
  }
  return [...new Set(value)];
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function nullableText(value: unknown, name: string): string | null {
  if (value === null) return null;
  return requiredText(value, name);
}
