import { adapterUrl } from "./adapter-parse-failure";
import { officialSourceAuthorities } from "./official-source-authority";
import { AdapterParseFailure } from "./adapter-parse-failure";
import { officialArtworkFingerprint } from "./official-artwork-identity";
import { normalizeOnePieceCardPage, normalizedOnePieceRarity } from "./one-piece-source-adapter";
import type { RawAdapterDefinition } from "./adapter-contract";
import {
  type NormalizedSurfaceBody,
  canonicalDetail,
  normalizePartitionEntries,
  normalizedDiscovery,
  normalizedPartitions,
  normalizedPolicy,
  normalizedSurfaceBody,
  productReleaseNormalizers,
  requiredArray,
  requiredRecord,
  requiredText,
  stableValue,
} from "./adapter-normalization";
import {
  type ParsedBandaiSurface,
  cardObservation,
  decodeHtmlText,
  firstLabelValue,
  htmlAttribute,
  htmlLabelPairs,
  htmlText,
  integerOrNull,
  requiredHtmlMatch,
  textValues,
} from "./adapter-html";
import { createBandaiAdapter } from "./bandai-adapter-runtime";

const productRelease = productReleaseNormalizers({
  gameLabel: "One Piece",
  productCode: "product_code",
  productName: "product_name",
  releaseEvent: "announcement_id",
});
const definition: RawAdapterDefinition = {
  sourceLineage: "one-piece-en",
  supportedGame: "one-piece",
  format: "one-piece",
  ...officialSourceAuthorities["one-piece-en"]!,
  partition: "EN-OCEANIA",
  reconciliationAreas: ["catalogue", "errata"],
  inheritDiscoveryRequestHeaders: false,
  listingReconciliation: {
    releasesSurfaceCarriesLegality: true,
    groupsPublisherPages: false,
    strictListingIdentity: false,
    duplicateLocatorCompatibility: "semantic",
  },
  requiredSurfaces: ["card-list", "products", "releases", "restrictions", "block-policy", "errata", "don-rules"],
  urls: {
    // /cardlist/ 302s to ./?series=<latest>; the discovery root pins the
    // live redirect target, and remaining Recordings are enumerated from
    // its series facet.
    "card-list": "https://en.onepiece-cardgame.com/cardlist/?series=569116",
    products: "https://en.onepiece-cardgame.com/products/",
    releases: "https://en.onepiece-cardgame.com/products/",
    // /rules/restriction/ 302s to the news publication and
    // /rules/block_icon/ is gone; the rules hub links these live pages.
    restrictions: "https://en.onepiece-cardgame.com/news/restriction.html",
    "block-policy": "https://en.onepiece-cardgame.com/topics/013.php",
    errata: "https://en.onepiece-cardgame.com/rules/errata_card/",
    "don-rules": "https://en.onepiece-cardgame.com/rules/",
  },
  version: {
    adapterVersion: "one-piece-en@6",
    parserContract: "one-piece-en-restructured-complete-catalogue@6",
    expandedOnePieceCatalogue: true,
    catalogueComplete: false,
    completeDigimonCatalogue: false,
    optionalCardFields: false,
    unresolvedLegalityScopes: true,
    liveShapes: false,
  },
};
export const onePieceAdapter = createBandaiAdapter(
  definition,
  (_lineage, surface, raw) => normalizeOnePieceSurface(surface, raw, true, true),
  { inlineCardList: (html, url) => parseOnePieceBandaiCardListV1(html, url, true) },
);

function normalizeOnePieceSurface(
  surface: string,
  raw: Record<string, unknown>,
  expandedOnePieceCatalogue = false,
  unresolvedLegalityScopes = false,
): NormalizedSurfaceBody {
  if (surface === "card-list") {
    if (raw.page !== "card-list") {
      throw new AdapterParseFailure("One Piece card-list page identity is invalid.");
    }
    return normalizedSurfaceBody(
      normalizedDiscovery(
        raw.series_options,
        raw.page_info,
        expandedOnePieceCatalogue
          ? normalizeOnePieceDetails(raw.card_pages)
          : normalizeOnePieceDetailsV2(raw.card_pages),
        productRelease.products(raw.products),
        productRelease.releases(raw.release_schedule),
        "recording",
        exactOnePieceLeaves(raw.series_options),
      ),
      ["page", "series_options", "page_info", "card_pages", "products", "release_schedule"],
    );
  }
  if (surface === "products") {
    if (raw.page !== "product-list") {
      throw new AdapterParseFailure("One Piece Product page identity is invalid.");
    }
    return normalizedSurfaceBody(
      normalizedPartitions(normalizePartitionEntries(raw.result, productRelease.product), "recording"),
      ["page", "series_options", "result"],
    );
  }
  if (surface === "releases") {
    if (raw.publication !== "release-schedule") {
      throw new AdapterParseFailure("One Piece Release publication identity is invalid.");
    }
    return normalizedSurfaceBody(
      {
        ...normalizedPartitions(normalizePartitionEntries(raw.events, productRelease.releaseEntry), "release-event"),
        entries: requiredArray(raw.release_timing_entries, "One Piece release-timing entries"),
      },
      ["publication", "events", "release_timing_entries"],
    );
  }
  if (!expandedOnePieceCatalogue) {
    return normalizedSurfaceBody(normalizedPolicy(raw, `one-piece-${surface}`), [
      "publication",
      "revision",
      "declared_record_count",
      "partition",
      "entries",
    ]);
  }
  const policy = normalizedPolicy(raw, `one-piece-${surface}`, surface === "don-rules" ? ["don_card"] : []);
  // The issue-58 contract accepts don-rules coverage without a DON!! payload
  // fact; when the publisher does demonstrate one it is still normalized
  // exactly. Earlier generations keep requiring the payload.
  const hasDonCard = surface === "don-rules" && (!unresolvedLegalityScopes || raw.don_card !== undefined);
  return normalizedSurfaceBody(
    {
      ...policy,
      ...(hasDonCard
        ? {
            don_card: requiredRecord(raw.don_card, "One Piece DON!! rules Card"),
          }
        : {}),
    },
    ["publication", "revision", "declared_record_count", "partition", "entries", ...(hasDonCard ? ["don_card"] : [])],
  );
}

function exactOnePieceLeaves(value: unknown): string[] {
  return requiredArray(value, "One Piece Recording vocabulary").map((item) => {
    if (typeof item === "string") return requiredText(item, "Recording");
    const record = requiredRecord(item, "One Piece Recording");
    return requiredText(record.value, "One Piece Recording value");
  });
}

function normalizeOnePieceDetails(value: unknown): unknown[] {
  return requiredArray(value, "One Piece Card pages").map((item) => {
    const card = requiredRecord(item, "One Piece Card page");
    const printing = card.printing === undefined ? null : requiredRecord(card.printing, "One Piece Printing fields");
    const forbiddenIdentityField = ["artwork_fingerprint", "printed_fields_digest"].find(
      (field) => Object.hasOwn(card, field) || (printing !== null && Object.hasOwn(printing, field)),
    );
    if (forbiddenIdentityField !== undefined) {
      throw new AdapterParseFailure(
        `One Piece raw Card pages cannot supply identity digest ${forbiddenIdentityField}.`,
      );
    }
    const normalized = normalizeOnePieceCardPage(card);
    const cardNumber = requiredText(card.card_number, "One Piece Card number");
    return canonicalDetail(card, {
      path: "source_record_id",
      number: "card_number",
      title: "name",
      rules: "Effect",
      attributes: normalized.attributes,
      printingAttributes: normalized.printingAttributes,
      normalizedRarity: normalized.normalizedRarity,
      artworkFingerprint: officialArtworkFingerprint(cardNumber, ["front"], null),
      printedFieldsDigest: `printed-material:${JSON.stringify(
        stableValue({
          card_number: cardNumber,
          category: card.Category,
          colour: card.Color,
          cost: card.Cost,
          life: card.Life,
          attribute: card.Attribute,
          power: card.Power,
          counter: card.Counter,
          type: card.Type,
          block_icon: card["Block icon"],
          effect: card.Effect,
          trigger: card.Trigger,
          rarity: printing?.rarity ?? null,
          variant: card.variant ?? null,
        }),
      )}`,
      imageFields: [{ role: "front", value: card.image_url }],
    });
  });
}

function normalizeOnePieceDetailsV2(value: unknown): unknown[] {
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

function parseOnePieceBandaiCardListV1(
  html: string,
  requestUrl: string,
  expandedOnePieceCatalogue = false,
): ParsedBandaiSurface {
  const recordingSelect = expandedOnePieceCatalogue
    ? html.match(/<select\b[^>]*\b(?:id|name)=["']series["'][^>]*>([\s\S]*?)<\/select>/iu)
    : html.match(/<select\b[^>]*\b(?:id|name)=["']recording["'][^>]*>([\s\S]*?)<\/select>/iu);
  if (recordingSelect === null) {
    throw new AdapterParseFailure("One Piece Card List Recording discovery is unavailable.");
  }
  const declaredMatch = html.match(
    /<div\b[^>]*\bclass=["'][^"']*\bcountCol\b[^"']*["'][^>]*>\s*(\d+)\s+results?\s*<\/div>/iu,
  );
  if (declaredMatch === null) {
    throw new AdapterParseFailure("One Piece Card List result count is unavailable.");
  }
  const recordings = [
    ...recordingSelect[1]!.matchAll(/<option\b[^>]*\bvalue=["']([^"']+)["'][^>]*>([\s\S]*?)<\/option>/giu),
  ]
    .filter((match) => /^\d+$/u.test(match[1]!))
    .map((match) => ({
      value: decodeHtmlText(match[1]!),
      label: htmlText(match[2]!),
    }));
  if (recordings.length === 0) {
    throw new AdapterParseFailure("One Piece Card List Recording discovery is empty.");
  }
  const modalMatches = [
    ...html.matchAll(
      /<dl\b[^>]*\bclass=["'][^"']*\bmodalCol\b[^"']*["'][^>]*\s+id=["']([^"']+)["'][^>]*>([\s\S]*?)<\/dl>/giu,
    ),
  ];
  const declaredCount = Number.parseInt(declaredMatch[1]!, 10);
  if (modalMatches.length !== declaredCount) {
    throw new AdapterParseFailure("One Piece Card List declared and parsed record counts differ.");
  }
  const base = adapterUrl(requestUrl);
  const recordingKey = expandedOnePieceCatalogue ? "series" : "recording";
  const recordingValues = base.searchParams.getAll(recordingKey);
  if (expandedOnePieceCatalogue && recordingValues.length > 1) {
    throw new AdapterParseFailure("One Piece Card List Recording identity is duplicated.");
  }
  const recording = recordingValues[0] ?? null;
  if (recording !== null && !/^\d+$/u.test(recording)) {
    throw new AdapterParseFailure("One Piece Card List Recording identity is invalid.");
  }
  const schemaReviewValues: {
    locator: string;
    field: string;
    value: string;
  }[] = [];
  const observations = modalMatches.map((match) => {
    const locator = decodeHtmlText(match[1]!);
    const body = match[2]!;
    const info = requiredHtmlMatch(
      body,
      /<div\b[^>]*\bclass=["'][^"']*\binfoCol\b[^"']*["'][^>]*>\s*<span>([\s\S]*?)<\/span>\s*\|\s*<span>([\s\S]*?)<\/span>\s*\|\s*<span>([\s\S]*?)<\/span>/iu,
      "One Piece Card identity",
    );
    const cardNumber = htmlText(info[1]!);
    const rarity = htmlText(info[2]!);
    const cardType = htmlText(info[3]!).toLowerCase();
    const name = htmlText(
      requiredHtmlMatch(
        body,
        /<div\b[^>]*\bclass=["'][^"']*\bcardName\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/iu,
        "One Piece Card name",
      )[1]!,
    );
    const imagePath = decodeHtmlText(
      requiredHtmlMatch(
        body,
        /<div\b[^>]*\bclass=["'][^"']*\bfrontCol\b[^"']*["'][^>]*>[\s\S]*?<img\b[^>]*\bdata-src=["']([^"']+)["']/iu,
        "One Piece Printing image",
      )[1]!,
    );
    const imageUrl = adapterUrl(imagePath, base).href;
    const pairs = htmlLabelPairs(body);
    const field = (...labels: string[]): string | null => firstLabelValue(pairs, labels);
    const effect = requiredNullableText(field("Effect", "Card Text", "Text"), "Official effect");
    const setLabel = field("Card Set(s)", "Where to get it") ?? "Unclassified Card List";
    const colour = requiredNullableText(field("Color", "Colour"), "Official colour");
    const variant = locator === cardNumber ? "base" : locator.slice(cardNumber.length);
    const modalTag = match[0]!.slice(0, match[0]!.indexOf(">") + 1);
    const artworkId =
      htmlAttribute(modalTag, "data-artwork-id") ?? field("Artwork ID", "Artwork Identifier", "Illustration ID");
    const rawTreatment = htmlAttribute(modalTag, "data-artwork-treatment") ?? field("Artwork Treatment", "Treatment");
    const treatment = officialArtworkTreatment(rawTreatment);
    if (rawTreatment !== null && treatment === null) {
      schemaReviewValues.push({
        locator,
        field: "One Piece artwork treatment",
        value: rawTreatment,
      });
    }
    const normalizedRarity =
      rarity.length === 0 ? null : expandedOnePieceCatalogue ? normalizedOnePieceRarity(rarity) : rarity.toLowerCase();
    if (expandedOnePieceCatalogue) {
      for (const pair of pairs.filter(({ label }) => !onePieceKnownCardListLabel(label))) {
        schemaReviewValues.push({
          locator,
          field: pair.label,
          value: pair.value,
        });
      }
    }
    const artworkFingerprint = officialArtworkFingerprint(cardNumber, ["front"], artworkId);
    const printedFieldsDigest = `printed-material:${JSON.stringify(
      stableValue({
        card_number: cardNumber,
        rarity,
        card_type: cardType,
        rules: effect ?? "",
        colour,
        cost: field("Cost"),
        life: field("Life"),
        attribute: field("Attribute"),
        power: field("Power"),
        counter: field("Counter"),
        feature: field("Type", "Traits"),
        block: field("Block icon", "Block"),
        trigger: field("Trigger"),
      }),
    )}`;
    const cost = integerOrNull(field("Cost"));
    const life = expandedOnePieceCatalogue
      ? integerOrNull(field("Life"))
      : cardType === "leader"
        ? integerOrNull(field("Life"))
        : null;
    if (expandedOnePieceCatalogue) {
      assertOnePieceTypeNullability(cardType, cost, life, field("Cost"));
    }
    const detail = {
      path: locator,
      number: cardNumber,
      title: name,
      rules: effect ?? "",
      profile: "one-piece@1",
      attributes: {
        card_type: cardType,
        colours: colour === null ? [] : colour.split("/").map((value) => value.trim().toLowerCase()),
        cost,
        life,
        battle_attributes: textValues(field("Attribute")).map((value) =>
          expandedOnePieceCatalogue ? value.toLocaleLowerCase() : value,
        ),
        power: integerOrNull(field("Power")),
        counter: integerOrNull(field("Counter")),
        traits: textValues(field("Type", "Traits")),
        block_icons: textValues(field("Block icon", "Block")),
        effect_text: effect,
        trigger_text: requiredNullableText(field("Trigger"), "Official trigger"),
      },
      product_codes: [],
      distribution: {
        code: `card-set:${setLabel}`,
        kind: "source_bucket",
        label: setLabel,
      },
      printing: {
        rarity: rarity.length === 0 ? null : rarity,
        normalizedRarity,
        attributes: expandedOnePieceCatalogue ? {} : { illustration_types: [] },
      },
      treatment,
      printed_rules: effect ?? "",
      variant,
      artwork_fingerprint: artworkFingerprint,
      printed_fields_digest: printedFieldsDigest,
      image: imageUrl,
      images: [
        {
          role: "front",
          source_url: imageUrl,
          artwork_fingerprint: artworkFingerprint,
        },
      ],
    };
    const observation = cardObservation(
      detail,
      [],
      new Map(),
      { revision: "captured-by-policy-surface", entries: [] },
      { revision: "captured-by-policy-surface", entries: [] },
      "one-piece",
    );
    return !expandedOnePieceCatalogue || recording === null
      ? observation
      : {
          ...observation,
          memberships: {
            ...requiredRecord(observation.memberships, "One Piece Recording memberships"),
            source_buckets: [`recording:${recording}`],
          },
        };
  });
  return {
    observations,
    retainedDocument: {
      page: "card-list",
      recording_options: recordings,
      declared_record_count: declaredCount,
      parsed_locators: modalMatches.map((match) => decodeHtmlText(match[1]!)),
      ...(expandedOnePieceCatalogue
        ? {
            raw_label_pairs: modalMatches.flatMap((match) =>
              htmlLabelPairs(match[2]!).map(({ label, value }) => ({
                locator: decodeHtmlText(match[1]!),
                label,
                value,
              })),
            ),
          }
        : {}),
      ...(schemaReviewValues.length === 0 ? {} : { schema_review_values: schemaReviewValues }),
    },
    consumedFields: [
      "page",
      "recording_options",
      "declared_record_count",
      "parsed_locators",
      ...(expandedOnePieceCatalogue ? ["raw_label_pairs"] : []),
    ],
  };
}

function onePieceKnownCardListLabel(label: string): boolean {
  return [
    "Effect",
    "Card Text",
    "Text",
    "Card Set(s)",
    "Where to get it",
    "Color",
    "Colour",
    "Cost",
    "Life",
    "Attribute",
    "Power",
    "Counter",
    "Type",
    "Traits",
    "Block icon",
    "Block",
    "Trigger",
    "Artwork ID",
    "Artwork Identifier",
    "Illustration ID",
    "Artwork Treatment",
    "Treatment",
  ].some((known) => known.localeCompare(label, undefined, { sensitivity: "accent" }) === 0);
}

function assertOnePieceTypeNullability(
  cardType: string,
  cost: number | null,
  life: number | null,
  printedCost: string | null = null,
): void {
  if (cardType === "leader" && cost !== null) {
    throw new AdapterParseFailure("One Piece Leader cost must be null.");
  }
  if (cardType !== "leader" && life !== null) {
    throw new AdapterParseFailure(`One Piece ${cardType} life must be null.`);
  }
  // The live publisher prints an explicit "-" cost for some Event Cards
  // (verified 2026-08-07 on OP16-020); an entirely missing cost field is
  // still unmodelled drift.
  if (cardType !== "leader" && cost === null && printedCost?.normalize("NFC").trim() !== "-") {
    throw new AdapterParseFailure(`One Piece ${cardType} cost must be non-null.`);
  }
  if (cardType === "leader" && life === null) {
    throw new AdapterParseFailure("One Piece Leader life must be non-null.");
  }
}

function officialArtworkTreatment(value: string | null): "standard" | "alternate" | null {
  if (value === null) return null;
  const normalized = value.normalize("NFC").trim().toLocaleLowerCase();
  if (["standard", "base"].includes(normalized)) return "standard";
  if (["alternate", "alternative", "alternate art", "alternative art"].includes(normalized)) {
    return "alternate";
  }
  return null;
}

function requiredNullableText(value: string | null, name: string): string | null {
  if (value === null) return null;
  if (value.length === 0) throw new AdapterParseFailure(`${name} is invalid.`);
  return value;
}
