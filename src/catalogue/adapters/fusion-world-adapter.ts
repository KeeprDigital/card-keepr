import type { RawAdapterDefinition } from "./adapter-contract";
import {
  attachRawSurfaceEvidenceV1,
  cardObservation,
  colourValues,
  completeObservation,
  decodeHtmlText,
  fusionWorldFullLocatorFromUrl,
  fusionWorldLocatorIdentity,
  htmlText,
  integerOrNull,
  liveOfficialProductCode,
  liveOfficialReleaseDateText,
  nonCardProductClassificationV2,
  productEventKey,
  productMapKey,
  productOnlyObservation,
  requiredHtmlMatch,
  textValues,
} from "./adapter-html";
import {
  canonicalDetail,
  type NormalizedSurfaceBody,
  normalizedDiscovery,
  normalizedPartitions,
  normalizedPolicy,
  normalizedSurfaceBody,
  normalizePartitionEntries,
  nullableText,
  productReleaseNormalizers,
  requiredArray,
  requiredRecord,
  requiredText,
  stableValue,
  uniqueTextValues,
} from "./adapter-normalization";
import type { CatalogueObservation, OfficialErratumObservation } from "./adapter-observations";
import { AdapterParseFailure, adapterUrl } from "./adapter-parse-failure";
import { parseProductDetail } from "./adapter-product-html";
import { createBandaiAdapter } from "./bandai-adapter-runtime";
import { officialArtworkFingerprint } from "./official-artwork-identity";
import { officialSourceAuthorities, officialUrl } from "./official-source-authority";
import { normalizedOfficialReleaseDate } from "./official-source-release-normalization";

const productRelease = productReleaseNormalizers({
  gameLabel: "Fusion World",
  productCode: "productCode",
  productName: "productName",
  releaseEvent: "releaseId",
});
const definition: RawAdapterDefinition = {
  sourceLineage: "fusion-world-en",
  supportedGame: "fusion-world",
  format: "fusion-world",
  ...officialSourceAuthorities["fusion-world-en"]!,
  partition: "EN-OCEANIA",
  // The live Fusion World EN site no longer publishes a Card Errata
  // surface: /fw/en/rules/errata-card/ returns 404 and no navigation,
  // rules, or FAQ page links an errata publication. The contract models
  // that reality instead of pinning a dead URL, so the lineage owns
  // Catalogue coverage only.
  reconciliationAreas: ["catalogue"],
  inheritDiscoveryRequestHeaders: false,
  listingReconciliation: {
    groupsPublisherPages: false,
    strictListingIdentity: true,
    duplicateLocatorCompatibility: "canonical",
  },
  requiredSurfaces: ["card-search", "products", "releases"],
  urls: {
    // /fw/en/cardlist/ 302s to its default category leaf; further
    // categories are enumerated from the "Filter by series" facet.
    "card-search": "https://www.dbs-cardgame.com/fw/en/cardlist/?search=true&category%5B0%5D=583301",
    products: "https://www.dbs-cardgame.com/fw/en/products/",
    releases: "https://www.dbs-cardgame.com/fw/en/products/",
  },
  // Issue #63: request capacity is a policy of each exact Source Adapter
  // Version, declared in src/catalogue/adapters/source-adapters.ts and the
  // source_adapter_versions seed.
  version: {
    adapterVersion: "fusion-world-en@9",
    parserContract: "fusion-world-en-restructured-complete-catalogue@7",
    expandedOnePieceCatalogue: false,
    catalogueComplete: true,
    completeDigimonCatalogue: false,
    optionalCardFields: true,
    liveShapes: true,
  },
};
export const fusionWorldAdapter = createBandaiAdapter(
  definition,
  (_lineage, surface, raw) => normalizeFusionWorldSurface(surface, raw, true),
  {
    productDetail: (html, lineage, url) =>
      parseProductDetail(
        html,
        {
          titleSuffix: /\s*[|｜]\s*Dragon Ball Super Card Game Fusion World - Official Web Site$/u,
          seasonPrecisionReleases: true,
        },
        lineage,
        url,
      ),
    structuredObservations: (surface, document) =>
      surface === "errata" ? fusionWorldOfficialErrataObservations(document) : [],
    productIndex: parseFusionWorldLiveProductIndex,
    validateProductCoverage: requireFusionWorldLiveProductStatusCoverage,
    cardDetail: parseFusionWorldCardDetailV6,
  },
);

function normalizeFusionWorldSurface(
  surface: string,
  raw: Record<string, unknown>,
  catalogueComplete = false,
): NormalizedSurfaceBody {
  if (surface === "card-search") {
    if (raw.view !== "card-search") {
      throw new AdapterParseFailure("Fusion World card-search view identity is invalid.");
    }
    const facets = requiredRecord(raw.facets, "Fusion World facets");
    for (const name of ["card_type", "colour", "cost"]) {
      requiredArray(facets[name], `Fusion World ${name} facet`);
    }
    return normalizedSurfaceBody(
      normalizedDiscovery(
        Object.entries(facets).map(([name, values]) => ({ name, values })),
        raw.result,
        normalizeFusionWorldDetails(raw.detail_pages, catalogueComplete),
        productRelease.products(raw.products),
        productRelease.releases(raw.releases),
        "card_type=leader&colour=red&cost=1",
        exactFusionLeaves(facets),
      ),
      ["view", "facets", "result", "detail_pages", "products", "releases"],
    );
  }
  if (surface === "products") {
    if (raw.view !== "products") {
      throw new AdapterParseFailure("Fusion World Product view identity is invalid.");
    }
    const tabs = uniqueTextValues(raw.status_tabs, "Fusion World Product tabs");
    if (!tabs.includes("available") || !tabs.includes("coming-soon")) {
      throw new AdapterParseFailure("Fusion World Product tabs are incomplete.");
    }
    if (catalogueComplete) {
      requireFusionWorldProductStatusLeaves(raw.result, tabs);
    }
    return normalizedSurfaceBody(
      normalizedPartitions(normalizePartitionEntries(raw.result, productRelease.product), "product-status"),
      ["view", "status_tabs", "result"],
    );
  }
  if (surface === "releases") {
    if (raw.publication !== "product-release-dates") {
      throw new AdapterParseFailure("Fusion World Release publication identity is invalid.");
    }
    return normalizedSurfaceBody(
      normalizedPartitions(normalizePartitionEntries(raw.events, productRelease.releaseEntry), "release-event"),
      ["publication", "events"],
    );
  }
  return normalizedSurfaceBody(normalizedPolicy(raw, `fusion-world-${surface}`), [
    "publication",
    "revision",
    "declared_record_count",
    "partition",
    "entries",
  ]);
}

function requireFusionWorldProductStatusLeaves(value: unknown, statuses: readonly string[]): void {
  const result = requiredRecord(value, "Fusion World Product partition result");
  const leaves = new Set(
    requiredArray(result.partitions, "Fusion World Product status leaves").map((item) =>
      requiredText(
        requiredRecord(item, "Fusion World Product status leaf").bucket,
        "Fusion World Product status leaf identity",
      ),
    ),
  );
  const missing = statuses.filter((status) => !leaves.has(status));
  const unexpected = [...leaves].filter((status) => !statuses.includes(status));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new AdapterParseFailure(
      `Fusion World Product status leaves do not match the discovered tabs; missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}.`,
    );
  }
}

function exactFusionLeaves(facets: Record<string, unknown>): string[] {
  const cardTypes = uniqueTextValues(facets.card_type, "Fusion World Card Type facets");
  const colours = uniqueTextValues(facets.colour, "Fusion World Colour facets");
  const costs = uniqueTextValues(facets.cost, "Fusion World Cost facets");
  return cardTypes.flatMap((cardType) =>
    colours.flatMap((colour) =>
      costs.map((cost) => `card_type=${cardType.toLowerCase()}&colour=${colour.toLowerCase()}&cost=${cost}`),
    ),
  );
}

function normalizeFusionWorldDetails(value: unknown, validateIdentity = false): unknown[] {
  return requiredArray(value, "Fusion World Card details").map((item) => {
    const card = requiredRecord(item, "Fusion World Card detail");
    if (validateIdentity) validateFusionWorldDetailIdentity(card);
    const images = requiredArray(card.image_urls, "Fusion World Card images").map((image) => {
      const record = requiredRecord(image, "Fusion World Card image");
      return {
        role: requiredText(record.role, "Fusion World image role"),
        value: record.url,
      };
    });
    if (
      card.card_type === "leader" &&
      (images.length !== 2 ||
        new Set(images.map(({ role }) => role)).size !== 2 ||
        !images.some(({ role }) => role === "front") ||
        !images.some(({ role }) => role === "back"))
    ) {
      throw new AdapterParseFailure("Fusion World Leader requires exact front and back image roles.");
    }
    return canonicalDetail(validateIdentity ? fusionWorldPublisherDetailV3(card, images) : card, {
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
        ...(card.leader_faces === undefined ? {} : { leader_faces: card.leader_faces }),
      },
      imageFields: images,
    });
  });
}

function fusionWorldPublisherDetailV3(
  card: Record<string, unknown>,
  images: readonly { role: string; value: unknown }[],
): Record<string, unknown> {
  const prohibited = ["profile", "artwork_fingerprint", "printed_fields_digest"].find((field) =>
    Object.hasOwn(card, field),
  );
  if (prohibited !== undefined) {
    throw new AdapterParseFailure(`Fusion World detail contains caller-supplied canonical field ${prohibited}.`);
  }
  const printing =
    card.printing === undefined ? undefined : requiredRecord(card.printing, "Fusion World Printing fields");
  if (printing !== undefined && Object.hasOwn(printing, "normalized_rarity")) {
    throw new AdapterParseFailure("Fusion World detail contains caller-supplied canonical field normalized_rarity.");
  }
  const cardNumber = requiredText(card.card_number, "Fusion World Card number");
  const variant = requiredText(card.variant, "Fusion World variant suffix");
  const rarity = printing === undefined ? null : nullableText(printing.rarity, "Fusion World Printing rarity");
  const printedFields = {
    card_number: cardNumber,
    card_type: card.card_type,
    color: card.color,
    combo_power: card.combo_power,
    cost: card.cost,
    power: card.power,
    printed_rules: card.printed_rules,
    skills: card.skills,
    special_traits: card.special_traits,
    specified_cost: card.specified_cost,
    rarity,
    variant,
  };
  return {
    ...card,
    profile: "fusion-world@1",
    ...(printing === undefined
      ? {}
      : {
          printing: {
            ...printing,
            normalized_rarity: rarity?.toLowerCase() ?? null,
          },
          artwork_fingerprint: officialArtworkFingerprint(
            cardNumber,
            images.map(({ role }) => role),
            variant,
          ),
          printed_fields_digest: `printed-material:${JSON.stringify(stableValue(printedFields))}`,
        }),
  };
}

function validateFusionWorldDetailIdentity(card: Record<string, unknown>): void {
  const locator = requiredText(card.detail_path, "Fusion World full locator");
  const cardNumber = requiredText(card.card_number, "Fusion World Card number");
  const variant = requiredText(card.variant, "Fusion World variant suffix");
  const expectedLocatorTail = variant === "base" ? cardNumber : `${cardNumber}${variant}`;
  const locatorTail = locator.split("/").filter(Boolean).at(-1);
  if (locatorTail !== expectedLocatorTail) {
    throw new AdapterParseFailure(
      `Fusion World full locator ${locator} does not match Card number ${cardNumber} and variant ${variant}.`,
    );
  }
}

function parseFusionWorldCardDetailV6(html: string, sourceLineage: string, requestUrl: string): CatalogueObservation {
  // The live detail pages (verified 2026-08-12 on SB01-039, FB01-046,
  // FS10-01 and its _p1 variant, the FB06 variant reprints, and FP-088)
  // annotate errata'd Skills and Special Traits labels with a face-scoped
  // "(Errata Applied)" span and nest one pinned Errata Notice link in the
  // annotated face's data cell. The annotated text is the effective
  // publication, so the printed-rules claim is withheld exactly where the
  // publisher declares the applied erratum.
  return parseFusionWorldCardDetailByContract(html, sourceLineage, requestUrl, true, true);
}

function parseFusionWorldCardDetailByContract(
  html: string,
  sourceLineage: string,
  requestUrl: string,
  optionalEnergyMarkerRarity: boolean,
  errataAnnotatedLabels = false,
): CatalogueObservation {
  const request = adapterUrl(requestUrl);
  const requestedLocator = fusionWorldFullLocatorFromUrl(request, true);
  if (requestedLocator === null) {
    throw new AdapterParseFailure("Fusion World detail request has no full locator.");
  }
  const identity = fusionWorldLocatorIdentity(requestedLocator);
  const cardNumberMatches = [...html.matchAll(/<div\b[^>]*\bclass=["']cardNo["'][^>]*>([\s\S]*?)<\/div>/giu)];
  if (cardNumberMatches.length !== 1) {
    throw new AdapterParseFailure("Fusion World Card detail is missing its Card Number.");
  }
  const cardNumber = htmlText(cardNumberMatches[0]![1]!);
  if (identity.cardNumber !== cardNumber.normalize("NFC").trim()) {
    throw new AdapterParseFailure(
      `Fusion World full locator ${requestedLocator} does not match Card number ${cardNumber}.`,
    );
  }
  const rarityMatches = [...html.matchAll(/<div\b[^>]*\bclass=["']rarity["'][^>]*>([\s\S]*?)<\/div>/giu)];
  const cells = fusionWorldDetailCells(html, errataAnnotatedLabels);
  const errataAnnotatedCells = cells.filter((cell) => cell.errataFaces.length > 0 || cell.errataNotices.length > 0);
  for (const cell of errataAnnotatedCells) {
    if (cell.label !== "Skills" && cell.label !== "Special Traits") {
      throw new AdapterParseFailure(
        "Fusion World Card detail publishes an Errata Applied annotation on an unmodelled cell.",
      );
    }
    const annotated = [...cell.errataFaces].sort().join(",");
    const linked = [...new Set(cell.errataNotices.map(({ face }) => face))].sort().join(",");
    if (
      annotated !== linked ||
      cell.errataNotices.length !== cell.errataFaces.length ||
      new Set(cell.errataFaces).size !== cell.errataFaces.length
    ) {
      throw new AdapterParseFailure("Fusion World Errata Applied annotation and its Errata Notice link do not match.");
    }
    for (const { url } of cell.errataNotices) {
      const resolved = adapterUrl(url, requestUrl);
      if (resolved.protocol !== "https:" || !officialUrl(sourceLineage, resolved, "document")) {
        throw new AdapterParseFailure("Fusion World Errata Notice link is outside registered authority.");
      }
    }
  }
  const cellFor = (label: string) =>
    cells.find((cell) => cell.label.localeCompare(label, undefined, { sensitivity: "accent" }) === 0) ?? null;
  const requiredCell = (label: string) => {
    const cell = cellFor(label);
    if (cell === null) {
      throw new AdapterParseFailure(`Fusion World Card detail is missing its ${label}.`);
    }
    return cell;
  };
  const cardType = htmlText(requiredCell("Card type").shared ?? "");
  if (cardType.length === 0) {
    throw new AdapterParseFailure("Fusion World Card detail is missing its Card type.");
  }
  const normalizedType = cardType.toLowerCase().replace(/\s+/gu, "_");
  const leader = normalizedType === "leader";
  if (!leader && errataAnnotatedCells.some((cell) => cell.errataFaces.some((face) => face !== "front"))) {
    // Single-faced Cards publish exactly one face; the live annotation
    // always scopes it as the front.
    throw new AdapterParseFailure("Fusion World Errata Applied annotation names a face this Card does not publish.");
  }
  const energyMarkerWithoutRarity = optionalEnergyMarkerRarity && normalizedType === "energy_marker";
  if (energyMarkerWithoutRarity && rarityMatches.length !== 0) {
    throw new AdapterParseFailure("Fusion World Energy Marker detail must not publish a rarity.");
  }
  if (!energyMarkerWithoutRarity && rarityMatches.length !== 1) {
    throw new AdapterParseFailure("Fusion World Card detail is missing its rarity.");
  }
  const rarity = energyMarkerWithoutRarity ? null : htmlText(rarityMatches[0]![1]!);
  const colourCell = requiredCell("Color");
  const colourTokens = [...(colourCell.shared ?? "").matchAll(/\bdata-color=["']([^"']+)["']/giu)].map((match) =>
    decodeHtmlText(match[1]!),
  );
  const colourValue = colourTokens.length > 0 ? colourTokens.join("/") : htmlText(colourCell.shared ?? "");
  const colours = colourValue === "-" ? ["colourless"] : colourValues(colourValue);
  if (colours.length === 0) {
    throw new AdapterParseFailure("Fusion World Card detail is missing its Color.");
  }
  const cost = integerOrNull(htmlText(requiredCell("Cost").shared ?? ""));
  const specifiedCostCell = requiredCell("Specified cost");
  const specifiedCostIcons = [
    ...(specifiedCostCell.shared ?? "").matchAll(
      /<span\b[^>]*\bclass=["'][^"']*\bcostIcon-(red|blue|green|yellow|black)\b[^"']*["'][^>]*>/giu,
    ),
  ].map((match) => match[1]!.toLocaleLowerCase());
  if (specifiedCostIcons.length === 0 && htmlText(specifiedCostCell.shared ?? "") !== "-") {
    throw new AdapterParseFailure("Fusion World Card detail specified cost is unrecognized.");
  }
  const specifiedCost = [
    ...specifiedCostIcons
      .reduce((counts, colour) => {
        counts.set(colour, (counts.get(colour) ?? 0) + 1);
        return counts;
      }, new Map<string, number>())
      .entries(),
  ].map(([colour, count]) => ({ colour, count }));
  const powerCell = requiredCell("Power");
  const comboPower = integerOrNull(htmlText(requiredCell("Combo power").shared ?? ""));
  const traitsCell = requiredCell("Special Traits");
  const skillsCell = requiredCell("Skills");
  const whereToGet = htmlText(requiredCell("Where to get it").shared ?? "");
  if (whereToGet.length === 0) {
    throw new AdapterParseFailure("Fusion World Card detail is missing its Where to get it evidence.");
  }
  const faceValue = (
    cell: { shared: string | null; front: string | null; back: string | null },
    role: "front" | "back",
  ): string | null => {
    const value = role === "front" ? cell.front : cell.back;
    return value ?? cell.shared;
  };
  const faceNames = fusionWorldDetailNames(html);
  const faceImages = fusionWorldDetailImages(html, sourceLineage, requestUrl, leader);
  const faces = leader
    ? (["front", "back"] as const).map((role) => {
        const name = role === "front" ? faceNames.front : faceNames.back;
        const imageUrl = faceImages[role];
        const skills = faceValue(skillsCell, role);
        if (name === null || imageUrl === undefined || skills === null) {
          throw new AdapterParseFailure(`Fusion World Leader ${role} face evidence is incomplete.`);
        }
        return {
          role,
          name: htmlText(name),
          power: integerOrNull(htmlText(faceValue(powerCell, role) ?? "")),
          traits: textValues(htmlText(faceValue(traitsCell, role) ?? "")),
          skills: htmlText(skills),
          imageUrl,
        };
      })
    : null;
  const name = leader ? faces![0]!.name : htmlText(faceNames.single ?? "");
  if (name.length === 0) {
    throw new AdapterParseFailure("Fusion World Card detail is missing its Card name.");
  }
  const rules = leader ? faces![0]!.skills : htmlText(skillsCell.shared ?? "");
  if (rules.length === 0) {
    throw new AdapterParseFailure("Fusion World Card detail is missing its Skills.");
  }
  const imageEvidence = leader
    ? faces!.map(({ role, imageUrl }) => ({ role, source_url: imageUrl }))
    : [{ role: "front" as const, source_url: faceImages.single! }];
  const power = leader ? faces![0]!.power : integerOrNull(htmlText(powerCell.shared ?? ""));
  const traits = leader ? faces![0]!.traits : textValues(htmlText(traitsCell.shared ?? ""));
  const attributes = {
    card_type: normalizedType,
    colours,
    cost,
    specified_cost: specifiedCost,
    power,
    combo_power: comboPower,
    traits,
    skills: [{ kind: "ordinary", text: rules }],
    ...(leader
      ? {
          leader_faces: faces!.map((face) => ({
            role: face.role,
            name: face.name,
            power: face.power,
            traits: face.traits,
            skills: face.skills,
          })),
        }
      : {}),
  };
  const artworkFingerprint = officialArtworkFingerprint(
    cardNumber,
    imageEvidence.map(({ role }) => role),
    null,
  );
  // The face whose displayed Skills text carries the publisher's errata
  // annotation publishes its effective text. `rules` always reads the front
  // (or single) face, so the printed-rules claim is withheld exactly when
  // that face is annotated; a Leader whose back face alone is annotated
  // keeps its exact front-face printed claim.
  const printedRulesErrataApplied = skillsCell.errataFaces.includes("front");
  const errataApplied = errataAnnotatedCells
    .flatMap((cell) =>
      cell.errataNotices.map(({ face, url }) => ({
        cell: cell.label,
        face,
        notice_url: adapterUrl(url, requestUrl).href,
      })),
    )
    .sort((left, right) => `${left.cell}:${left.face}`.localeCompare(`${right.cell}:${right.face}`));
  const detail = {
    path: requestedLocator,
    number: cardNumber,
    title: name,
    rules,
    profile: "fusion-world@1",
    attributes,
    product_codes: [],
    fuzzy_product_labels: [],
    distribution: {
      code: `card-set:${whereToGet}`,
      kind: "source_bucket",
      label: whereToGet,
    },
    printing: {
      rarity: rarity === null || rarity.length === 0 ? null : rarity,
      normalizedRarity: rarity === null || rarity.length === 0 ? null : rarity.toLowerCase(),
      attributes: {},
    },
    treatment: null,
    printed_rules: printedRulesErrataApplied ? null : rules,
    variant: identity.variant,
    artwork_fingerprint: artworkFingerprint,
    printed_fields_digest: `printed-material:${JSON.stringify(stableValue({ rules, attributes }))}`,
    image: imageEvidence[0]!.source_url,
    images: imageEvidence.map(({ role, source_url }) => ({
      role,
      source_url,
      artwork_fingerprint: artworkFingerprint,
    })),
  };
  const observation = cardObservation(
    detail,
    [],
    new Map(),
    { revision: "captured-by-policy-surface", entries: [] },
    "fusion-world",
  );
  const document = {
    card_number: cardNumber,
    rarity,
    ...Object.fromEntries(
      cells.map((cell) => [cell.label, htmlText(cell.shared ?? `${cell.front ?? ""} ${cell.back ?? ""}`)]),
    ),
    ...(errataApplied.length === 0 ? {} : { errata_applied: errataApplied }),
  };
  return attachRawSurfaceEvidenceV1(observation, sourceLineage, "card-detail", document, true, [
    "card_number",
    "rarity",
    "Card type",
    "Color",
    "Cost",
    "Specified cost",
    "Power",
    "Combo power",
    "Special Traits",
    "Skills",
    "Where to get it",
    ...(errataApplied.length === 0 ? [] : ["errata_applied"]),
  ]);
}

// The exact live publisher annotation and notice-link shapes verified on
// 2026-08-12: the Skills / Special Traits label carries a face-scoped
// "(Errata Applied)" span, and the annotated face's data cell nests one
// pinned "Errata Notice" publication link (the href is unquoted in the
// live markup).
const fusionErrataAnnotationPattern = /<span class="is-(front|back)"> \(Errata Applied\)<\/span>/gu;
const fusionErrataNoticePattern =
  /\s*<div class="cardNotesBtnCol"><a class="cardNotesBtn" href=(\S+) target="_blank" rel="noopener noreferrer">Errata Notice<\/a><\/div>/gu;

type FusionWorldDetailCell = {
  label: string;
  shared: string | null;
  front: string | null;
  back: string | null;
  errataFaces: ("front" | "back")[];
  errataNotices: { face: "front" | "back"; url: string }[];
};

function fusionWorldDetailCells(html: string, errataAnnotatedLabels = false): FusionWorldDetailCell[] {
  const cellStarts = [...html.matchAll(/<div\b[^>]*\bclass=["'][^"']*\bcardDataCell\b[^"']*["'][^>]*>/giu)].map(
    (match) => match.index,
  );
  const boundary = html.search(/<div\b[^>]*\bclass=["'][^"']*\binformationCol\b[^"']*["'][^>]*>/iu);
  return cellStarts.map((start, index) => {
    const rawChunk = html.slice(start, cellStarts[index + 1] ?? (boundary >= 0 ? boundary : html.length));
    const errataFaces: ("front" | "back")[] = [];
    const errataNotices: { face: "front" | "back"; url: string }[] = [];
    let chunk = rawChunk;
    if (errataAnnotatedLabels) {
      for (const notice of rawChunk.matchAll(fusionErrataNoticePattern)) {
        const openings = [
          ...rawChunk.slice(0, notice.index).matchAll(/<div\b[^>]*\bclass=["']([^"']*\bdata\b[^"']*)["'][^>]*>/giu),
        ];
        const classes = openings.at(-1)?.[1]?.split(/\s+/u) ?? [];
        if (openings.length === 0) {
          throw new AdapterParseFailure("Fusion World Errata Notice link is outside a Card data cell.");
        }
        errataNotices.push({
          face: classes.includes("is-back") ? "back" : "front",
          url: decodeHtmlText(notice[1]!),
        });
      }
      chunk = rawChunk.replace(fusionErrataNoticePattern, "");
    }
    const labelHtml = requiredHtmlMatch(chunk, /<h6\b[^>]*>([\s\S]*?)<\/h6>/iu, "Fusion World Card data label")[1]!;
    if (errataAnnotatedLabels) {
      for (const annotation of labelHtml.matchAll(fusionErrataAnnotationPattern)) {
        errataFaces.push(annotation[1]! as "front" | "back");
      }
    }
    const label = htmlText(errataAnnotatedLabels ? labelHtml.replace(fusionErrataAnnotationPattern, "") : labelHtml);
    let shared: string | null = null;
    let front: string | null = null;
    let back: string | null = null;
    for (const value of chunk.matchAll(/<div\b[^>]*\bclass=["']([^"']*\bdata\b[^"']*)["'][^>]*>([\s\S]*?)<\/div>/giu)) {
      const classes = value[1]!.split(/\s+/u);
      if (classes.includes("is-front")) front = value[2]!;
      else if (classes.includes("is-back")) back = value[2]!;
      else if (shared === null) shared = value[2]!;
    }
    return {
      label,
      shared: shared ?? front,
      front,
      back,
      errataFaces,
      errataNotices,
    };
  });
}

function fusionWorldDetailNames(html: string): {
  single: string | null;
  front: string | null;
  back: string | null;
} {
  let single: string | null = null;
  let front: string | null = null;
  let back: string | null = null;
  for (const match of html.matchAll(/<h1\b[^>]*\bclass=["']([^"']*\bcardName\b[^"']*)["'][^>]*>([\s\S]*?)<\/h1>/giu)) {
    const classes = match[1]!.split(/\s+/u);
    if (classes.includes("is-front")) front = match[2]!;
    else if (classes.includes("is-back")) back = match[2]!;
    else single = match[2]!;
  }
  return { single: single ?? front, front, back };
}

function fusionWorldDetailImages(
  html: string,
  sourceLineage: string,
  requestUrl: string,
  leader: boolean,
): { single?: string; front?: string; back?: string } {
  const resolveOfficialImage = (raw: string): string => {
    const resolved = adapterUrl(decodeHtmlText(raw), requestUrl);
    if (!officialUrl(sourceLineage, resolved, "image")) {
      throw new AdapterParseFailure("Fusion World Card detail image is outside registered authority.");
    }
    return resolved.href;
  };
  if (!leader) {
    const image = html.match(
      /<div\b[^>]*\bclass=["'][^"']*\bcardImage\b[^"']*["'][^>]*>\s*<img\b[^>]*\bsrc=["']([^"']+)["']/iu,
    );
    if (image === null) {
      throw new AdapterParseFailure("Fusion World Card detail has no Printing Image URL.");
    }
    return { single: resolveOfficialImage(image[1]!) };
  }
  const faces: { front?: string; back?: string } = {};
  for (const match of html.matchAll(
    /<div\b[^>]*\bclass=["'][^"']*\bimg-(front|back)\b[^"']*["'][^>]*>\s*<img\b[^>]*\bsrc=["']([^"']+)["']/giu,
  )) {
    const role = match[1]!.toLowerCase() as "front" | "back";
    if (faces[role] !== undefined) {
      throw new AdapterParseFailure(`Fusion World Leader ${role} face requires exactly one role-specific image.`);
    }
    faces[role] = resolveOfficialImage(match[2]!);
  }
  if (faces.front === undefined || faces.back === undefined) {
    throw new AdapterParseFailure("Fusion World Leader requires explicit front and back face images.");
  }
  return faces;
}

function fusionWorldOfficialErrataObservations(document: Record<string, unknown>): OfficialErratumObservation[] {
  const entries = requiredArray(document.entries, "Fusion World Errata entries");
  return entries.map((value) => {
    const entry = requiredRecord(value, "Fusion World Erratum");
    const allowed = new Set([
      "entry_id",
      "card_number",
      "published_on",
      "effective_from",
      "before",
      "after",
      "notice",
      "image_url",
    ]);
    const unexpected = Object.keys(entry).find((field) => !allowed.has(field));
    if (unexpected !== undefined) {
      throw new AdapterParseFailure(`Fusion World Erratum contains unknown field ${unexpected}.`);
    }
    const entryId = requiredText(entry.entry_id, "Fusion World Erratum identity");
    const cardNumber = requiredText(entry.card_number, "Fusion World Erratum Card Number");
    const publishedOn = requiredText(entry.published_on, "Fusion World Erratum published date");
    const effectiveFrom =
      entry.effective_from === null ? null : requiredText(entry.effective_from, "Fusion World Erratum effective date");
    const before = requiredText(entry.before, "Fusion World Erratum Before text");
    const after = requiredText(entry.after, "Fusion World Erratum After text");
    const notice = requiredText(entry.notice, "Fusion World Erratum notice");
    const imageUrl = requiredText(entry.image_url, "Fusion World Erratum image URL");
    const image = adapterUrl(imageUrl);
    if (!officialUrl("fusion-world-en", image, "image")) {
      throw new AdapterParseFailure("Fusion World Erratum image provenance is invalid.");
    }
    return {
      kind: "official_erratum",
      game: "fusion-world",
      target: {
        type: "card",
        official_identity: { kind: "card_number", value: cardNumber },
      },
      published_on: publishedOn,
      effective_from: effectiveFrom,
      observed_printed_rules_text: before,
      corrected_rules_text: after,
      official_wording: `Before: ${before}\nAfter: ${after}\nNote: ${notice}`,
      applies_to_parallel_printings: true,
      source: {
        fragment: `#${entryId}`,
        display_name: cardNumber,
        image_url: image.href,
      },
      completeness: completeObservation(1, 1),
    };
  });
}

function requireFusionWorldLiveProductStatusCoverage(html: string): void {
  const sections = [...html.matchAll(/<section class="contentsColInner ([a-z-]+)Col" id="([a-z-]+)">/gu)].map(
    (match) => ({ classId: match[1]!, id: match[2]! }),
  );
  const anchors = [...html.matchAll(/<li class="ankerListItem"><a href="#([a-z-]+)">([^<]+)<\/a><\/li>/gu)].map(
    (match) => ({ id: match[1]!, label: decodeHtmlText(match[2]!) }),
  );
  const missing = fusionLiveProductSections
    .filter(
      (expected) =>
        sections.filter(({ classId, id }) => classId === expected.id && id === expected.id).length !== 1 ||
        anchors.filter(({ id, label }) => id === expected.id && label === expected.heading).length !== 1 ||
        !html.includes(`<section class="contentsColInner ${expected.id}Col" id="${expected.id}">`),
    )
    .map(({ id }) => id);
  const expectedIds = new Set<string>(fusionLiveProductSections.map(({ id }) => id));
  const unexpected = [
    ...sections.flatMap(({ classId, id }) => (expectedIds.has(id) && classId === id ? [] : [id])),
    ...anchors.flatMap(({ id }) => (expectedIds.has(id) ? [] : [id])),
  ];
  if (missing.length > 0 || unexpected.length > 0) {
    throw new AdapterParseFailure(
      `Fusion World Product status sections are incomplete; missing: ${
        missing.join(", ") || "none"
      }; unexpected: ${[...new Set(unexpected)].join(", ") || "none"}.`,
    );
  }
}

function parseFusionWorldLiveProductIndex(
  html: string,
  sourceLineage: string,
  requestUrl: string,
): CatalogueObservation[] {
  type LiveProductEntry =
    | {
        product: { code: string | null; title: string };
        status: "released" | "announced";
        date: { precision: string; value: string | null };
      }
    | {
        non_card_context: {
          key: string;
          kind: "other";
          label: string;
          evidence_category: "explicit";
        };
      };
  const entries: LiveProductEntry[] = [];
  for (const expected of fusionLiveProductSections) {
    // The products-surface coverage check is the fail-closed wall proving
    // both status sections; the index reads whichever sections the parsed
    // surface publishes.
    const section = html.match(
      new RegExp(`<section class="contentsColInner ${expected.id}Col" id="${expected.id}">([\\s\\S]*?)</section>`, "u"),
    )?.[1];
    if (section === undefined) continue;
    for (const item of section.matchAll(/<li class="prpductListItem cardCol">([\s\S]*?)<\/li>/gu)) {
      const body = item[1]!;
      const href = requiredHtmlMatch(
        body,
        /<a href="([^"]+)" class="cardLink">/u,
        "Fusion World Product listing link",
      )[1]!;
      const resolved = adapterUrl(decodeHtmlText(href), requestUrl);
      if (resolved.protocol !== "https:" || !officialUrl(sourceLineage, resolved, "document")) {
        throw new AdapterParseFailure("Fusion World Product listing link is outside registered authority.");
      }
      const title = htmlText(
        requiredHtmlMatch(body, /<h3 class="cardText">([\s\S]*?)<\/h3>/u, "Fusion World Product listing title")[1]!,
      );
      if (title.length === 0) {
        throw new AdapterParseFailure("Fusion World Product listing entry is missing its title.");
      }
      const info = [
        ...body.matchAll(/<dt class="cardInfoTit">([\s\S]*?)<\/dt>\s*<dd class="cardInfoTxt">([\s\S]*?)<\/dd>/gu),
      ].map((match) => ({
        label: htmlText(match[1]!),
        value: htmlText(match[2]!),
      }));
      const unknownLabel = info.find(({ label }) => label !== "RELEASE" && label !== "MSRP");
      const release = info.filter(({ label }) => label === "RELEASE");
      if (unknownLabel !== undefined || release.length !== 1) {
        throw new AdapterParseFailure("Fusion World Product listing entry publishes an unmodelled field.");
      }
      const nonCardClassification = nonCardProductClassificationV2(`${resolved.pathname} ${title}`);
      if (nonCardClassification !== null) {
        entries.push({
          non_card_context: {
            key: `non-card:${nonCardClassification}:${title.normalize("NFC").trim().toLocaleLowerCase()}`,
            kind: "other",
            label: nonCardClassification,
            evidence_category: "explicit",
          },
        });
        continue;
      }
      const date = normalizedOfficialReleaseDate(liveOfficialReleaseDateText(release[0]!.value), { seasons: true });
      entries.push({
        product: { code: liveOfficialProductCode(title), title },
        status: expected.status,
        date,
      });
    }
  }
  return [
    ...new Map(
      entries.map((entry) => [
        "product" in entry ? `product:${productMapKey(entry.product)}` : `context:${entry.non_card_context.key}`,
        entry,
      ]),
    ).values(),
  ].map((entry) => {
    if ("non_card_context" in entry) {
      return {
        completeness: completeObservation(),
        product_release_catalogue: {
          products: [],
          distribution_contexts: [entry.non_card_context],
          relationships: [],
        },
      };
    }
    const releases = new Map<string, Record<string, unknown>[]>();
    releases.set(productMapKey(entry.product), [
      {
        event_key: productEventKey("product-release", entry.product),
        region: "unknown",
        precision: entry.date.precision,
        date: entry.date.value,
        status: entry.status,
      },
    ]);
    return productOnlyObservation(entry.product, releases, { revision: "captured-by-policy-surface", entries: [] });
  });
}

// The live Fusion World Product listing (verified byte-identically on
// 2026-08-12 against the retained hub capture): the AVAILABLE NOW and
// COMING SOON statuses publish as anchored sections with exact anchor-list
// tabs instead of the status-attributed markup the retired generations
// modelled.
const fusionLiveProductSections = [
  { id: "available", heading: "AVAILABLE NOW", status: "released" },
  { id: "comingsoon", heading: "COMING SOON", status: "announced" },
] as const;
