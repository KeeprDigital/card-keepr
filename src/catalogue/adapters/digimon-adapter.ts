import type { RawAdapterDefinition } from "./adapter-contract";
import {
  attachRawSurfaceEvidenceV1,
  cardObservation,
  colourValues,
  completeObservation,
  decodeHtmlText,
  digimonTextSections,
  firstLabelValue,
  htmlAttribute,
  htmlLabelPairs,
  htmlText,
  integerOrNull,
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
  productReleaseNormalizers,
  requiredArray,
  requiredRecord,
  requiredText,
  uniqueTextValues,
} from "./adapter-normalization";
import type { CatalogueObservation, OfficialErratumObservation } from "./adapter-observations";
import { AdapterParseFailure, adapterUrl } from "./adapter-parse-failure";
import { parseProductDetail } from "./adapter-product-html";
import { createBandaiAdapter } from "./bandai-adapter-runtime";
import { officialSourceAuthorities, officialUrl } from "./official-source-authority";

const productRelease = productReleaseNormalizers({
  gameLabel: "Digimon",
  productCode: "productId",
  productName: "productTitle",
  releaseEvent: "calendarEntryId",
});
const definition: RawAdapterDefinition = {
  sourceLineage: "digimon-en",
  supportedGame: "digimon",
  format: "digimon",
  ...officialSourceAuthorities["digimon-en"]!,
  partition: "EN-OCEANIA",
  reconciliationAreas: ["catalogue", "errata"],
  inheritDiscoveryRequestHeaders: true,
  listingReconciliation: {
    releasesSurfaceCarriesLegality: false,
    groupsPublisherPages: false,
    strictListingIdentity: false,
    duplicateLocatorCompatibility: "never",
  },
  requiredSurfaces: ["card-list", "products", "releases", "restrictions-current", "restrictions-history", "errata"],
  urls: {
    "card-list": "https://world.digimoncard.com/cards/index.php?search=true",
    products: "https://world.digimoncard.com/products/",
    releases: "https://world.digimoncard.com/products/",
    "restrictions-current": "https://world.digimoncard.com/rule/restriction_card/",
    "restrictions-history": "https://world.digimoncard.com/rule/restriction_card/",
    errata: "https://world.digimoncard.com/rule/errata_card/",
  },
  version: {
    adapterVersion: "digimon-en@7",
    parserContract: "digimon-en-restructured-complete-catalogue@6",
    expandedOnePieceCatalogue: false,
    catalogueComplete: false,
    completeDigimonCatalogue: true,
    optionalCardFields: true,
    unresolvedLegalityScopes: false,
    liveShapes: false,
  },
};
export const digimonAdapter = createBandaiAdapter(
  definition,
  (_lineage, surface, raw) => normalizeDigimonSurface(surface, raw, true),
  {
    productDetail: (html, lineage, url) =>
      parseProductDetail(
        html,
        { titleSuffix: /\s*(?:[−–-]\s*PRODUCTS)?\s*[|｜]\s*Digimon Card Game$/u, seasonPrecisionReleases: false },
        lineage,
        url,
      ),
    structuredObservations: (surface, document) => (surface === "errata" ? parseDigimonOfficialErrata(document) : []),
    popupCardList: parseDigimonCardListPopupHtmlV6,
  },
);

function normalizeDigimonSurface(
  surface: string,
  raw: Record<string, unknown>,
  completeDigimonCatalogue = false,
): NormalizedSurfaceBody {
  if (surface === "card-list") {
    if (raw.view !== "card-list") {
      throw new AdapterParseFailure("Digimon card-list view identity is invalid.");
    }
    const filters = requiredRecord(raw.filters, "Digimon filters");
    for (const name of ["category", "cardcategory", "colour"]) {
      requiredArray(filters[name], `Digimon ${name} filter`);
    }
    return normalizedSurfaceBody(
      normalizedDiscovery(
        raw.version_options,
        raw.result,
        normalizeDigimonDetails(raw.card_popups, completeDigimonCatalogue),
        productRelease.products(raw.products),
        productRelease.releases(raw.release_calendar),
        "category=all&cardcategory=digimon&colour=blue",
        exactDigimonLeaves(filters),
      ),
      ["view", "version_options", "filters", "result", "card_popups", "products", "release_calendar"],
    );
  }
  if (surface === "products") {
    if (raw.view !== "product-index") {
      throw new AdapterParseFailure("Digimon Product index identity is invalid.");
    }
    requiredArray(raw.tile_categories, "Digimon Product tile categories");
    return normalizedSurfaceBody(
      normalizedPartitions(normalizePartitionEntries(raw.result, productRelease.product), "product-category"),
      ["view", "tile_categories", "result"],
    );
  }
  if (surface === "releases") {
    if (raw.publication !== "product-release-calendar") {
      throw new AdapterParseFailure("Digimon Release publication identity is invalid.");
    }
    return normalizedSurfaceBody(
      normalizedPartitions(normalizePartitionEntries(raw.events, productRelease.releaseEntry), "release-event"),
      ["publication", "events"],
    );
  }
  return normalizedSurfaceBody(normalizedPolicy(raw, `digimon-${surface}`), [
    "publication",
    "revision",
    "declared_record_count",
    "partition",
    "entries",
  ]);
}

function exactDigimonLeaves(filters: Record<string, unknown>): string[] {
  const categories = uniqueTextValues(filters.category, "Digimon Category filters");
  const cardCategories = uniqueTextValues(filters.cardcategory, "Digimon Card Type filters");
  const colours = uniqueTextValues(filters.colour, "Digimon Colour filters");
  return categories.flatMap((category) =>
    cardCategories.flatMap((cardCategory) =>
      colours.map(
        (colour) =>
          `category=${category.toLowerCase()}&cardcategory=${cardCategory.toLowerCase()}&colour=${colour.toLowerCase()}`,
      ),
    ),
  );
}

function normalizeDigimonDetails(value: unknown, completeCatalogue = false): unknown[] {
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
      preserveFuzzyProductLabels: completeCatalogue,
      derivePrintingIdentity: completeCatalogue,
    });
  });
}

function parseDigimonCardListPopupHtmlV6(html: string, requestUrl: string): CatalogueObservation[] {
  // The live Q&A answers may nest a related-cards list inside the answer
  // container (verified 2026-08-12 on the P-, LM-, and AD-01 leaves); the
  // nested list is retained as explicit related-card evidence.
  return parseDigimonCardListPopupHtmlByContract(html, requestUrl, digimonStructuralRecordCount(html), true, true);
}

function digimonStructuralRecordCount(html: string): number {
  const pagers = [...html.matchAll(/<div\b[^>]*\bclass=["'][^"']*\bpaging\b[^"']*["'][^>]*>/giu)];
  if (pagers.length < 1 || pagers.length > 2) {
    throw new AdapterParseFailure("Official Digimon Card List paging container is unavailable.");
  }
  const pages = [
    ...html.matchAll(/<li\b[^>]*\bclass=["']([^"']*\bimage_lists_item\b[^"']*\bdata\b[^"']*)["'][^>]*>/giu),
  ].map((match) => {
    const page = match[1]!.match(/\bpage-(\d+)\b/u);
    if (page === null) {
      throw new AdapterParseFailure("Official Digimon Card List record is missing its page marker.");
    }
    return Number.parseInt(page[1]!, 10);
  });
  const distinctPages = new Set(pages);
  for (let page = 1; page <= distinctPages.size; page += 1) {
    if (!distinctPages.has(page)) {
      throw new AdapterParseFailure("Official Digimon Card List page markers are not contiguous.");
    }
  }
  return pages.length;
}

function parseDigimonCardListPopupHtmlByContract(
  html: string,
  requestUrl: string,
  declaredRecordCount: number,
  optionalEffect = false,
  nestedRelatedQa = false,
): CatalogueObservation[] {
  const leafPublisherCardType = requiredText(
    adapterUrl(requestUrl).searchParams.get("cardcategory"),
    "Official Digimon leaf cardcategory",
  );
  const leafCardType = digimonProfileCardType(leafPublisherCardType, "Official Digimon leaf cardcategory");
  const recordStarts = [
    ...html.matchAll(/<li\b[^>]*\bclass=["'][^"']*\bimage_lists_item\b[^"']*\bdata\b[^"']*["'][^>]*>/giu),
  ].map((match) => match.index);
  const popupCount = [...html.matchAll(/<div\b[^>]*\bclass=["'][^"']*\bpopupCol\b[^"']*["'][^>]*>/giu)].length;
  if (popupCount !== recordStarts.length) {
    throw new AdapterParseFailure("Official Digimon Card List popup records are structurally incomplete.");
  }
  if (declaredRecordCount !== recordStarts.length) {
    throw new AdapterParseFailure("Official Digimon Card List declared and parsed record counts differ.");
  }
  if (recordStarts.length === 0) {
    return [
      attachRawSurfaceEvidenceV1(
        {
          completeness: completeObservation(0, 0),
          product_release_catalogue: {
            products: [],
            distribution_contexts: [],
            relationships: [],
          },
        },
        "digimon-en",
        "card-list",
        {
          declared_record_count: declaredRecordCount,
          leaf_cardcategory: leafPublisherCardType,
        },
        true,
        ["declared_record_count", "leaf_cardcategory"],
      ),
    ];
  }
  const records = recordStarts.map((start, index) => html.slice(start, recordStarts[index + 1] ?? html.length));
  return records.map((record) => {
    const popupMatches = [...record.matchAll(/<div\b([^>]*\bclass=["'][^"']*\bpopupCol\b[^"']*["'][^>]*)>/giu)];
    if (popupMatches.length !== 1) {
      throw new AdapterParseFailure("Official Digimon Card List record requires one exact popup.");
    }
    const locator = requiredText(htmlAttribute(popupMatches[0]![1]!, "id"), "Official Digimon popup locator");
    const locatorIdentity = locator.match(/^([A-Z]{1,6}\d{0,3}-\d{2,5})(?:_P(\d+))?$/u);
    if (locatorIdentity === null) {
      throw new AdapterParseFailure("Official Digimon popup locator is invalid.");
    }
    const cardAnchorMatches = [...record.matchAll(/<a\b([^>]*\bclass=["'][^"']*\bcard_img\b[^"']*["'][^>]*)>/giu)];
    if (cardAnchorMatches.length !== 1 || htmlAttribute(cardAnchorMatches[0]![1]!, "data-src") !== `#${locator}`) {
      throw new AdapterParseFailure("Official Digimon Card List anchor does not match its popup locator.");
    }
    const titleList = exactDigimonClassBody(record, "ul", "cardTitleList", "Official Digimon Card title fields");
    const titleFields = [...titleList.matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/giu)].map((match) => ({
      name: exactHtmlClassName(match[1]!),
      value: htmlText(match[2]!),
    }));
    const allowedTitleFields = new Set(["cardNo", "cardRarity", "cardType", "cardLv", "cardParallel"]);
    const unknownTitleField = titleFields.find(({ name }) => name === null || !allowedTitleFields.has(name));
    if (unknownTitleField !== undefined) {
      throw new AdapterParseFailure(
        `Official Digimon Card List contains unknown title field ${unknownTitleField.name ?? "without an exact class"}.`,
      );
    }
    const titleField = (name: string): string | null => {
      const matches = titleFields.filter((field) => field.name === name);
      if (matches.length > 1) {
        throw new AdapterParseFailure(`Official Digimon Card List duplicates ${name}.`);
      }
      return matches[0]?.value ?? null;
    };
    const cardNumber = requiredText(titleField("cardNo"), "Official Digimon Card number");
    if (cardNumber !== locatorIdentity[1]) {
      throw new AdapterParseFailure("Official Digimon Card number does not match its popup locator.");
    }
    const alternativeArtNumber = locatorIdentity[2];
    const alternativeArtLabel = titleField("cardParallel");
    if (
      (alternativeArtNumber === undefined && alternativeArtLabel !== null) ||
      (alternativeArtNumber !== undefined && alternativeArtLabel !== "Alternative Art")
    ) {
      throw new AdapterParseFailure("Official Digimon alternate-art marker does not match its popup locator.");
    }
    const publisherCardType = requiredText(titleField("cardType"), "Official Digimon Card type");
    const cardType = digimonProfileCardType(publisherCardType, "Official Digimon Card type");
    if (cardType !== leafCardType) {
      throw new AdapterParseFailure("Official Digimon Card Type does not match the leaf cardcategory.");
    }
    const levelValue = titleField("cardLv");
    const level = digimonCardLevel(levelValue, cardType);
    const info = exactDigimonClassBody(
      record,
      "div",
      "cardInfoCol",
      "Official Digimon Card information",
      /<\/div>\s*<!--\s*InfoCol\s*-->/iu,
    );
    const retainedQa = digimonCardQa(info, nestedRelatedQa);
    const pairs = htmlLabelPairs(retainedQa.remainingHtml);
    const allowedLabels = new Set([
      "Color",
      "Cost",
      "Play Cost",
      "Use Cost",
      "DP",
      "Form",
      "Attribute",
      "Type",
      "[Special Digivolution Condition]",
      "[Effect]",
      "Effect",
      "[Inherited Effect]",
      "Inherited Effect",
      "[Security Effect]",
      "Security Effect",
      "DUAL Color",
      "DUAL Cost",
      "[DUAL Effect]",
      "[DUAL Rule]",
      "[Link Condition]",
      "[Link DP]",
      "[Link Effect]",
      "Notes",
    ]);
    const unknownLabel = pairs.find(({ label }) => !allowedLabels.has(label) && !/^Digivolve Cost \d+$/u.test(label));
    if (unknownLabel !== undefined) {
      throw new AdapterParseFailure(`Official Digimon Card List contains unknown field ${unknownLabel.label}.`);
    }
    const duplicatedLabel = pairs.find(
      ({ label }, pairIndex) => pairs.findIndex((pair) => pair.label === label) !== pairIndex,
    );
    if (duplicatedLabel !== undefined) {
      throw new AdapterParseFailure(`Official Digimon Card List duplicates field ${duplicatedLabel.label}.`);
    }
    const mediumHeadings = [
      ...info.matchAll(/<div\b[^>]*\bclass=["'][^"']*\bcardInfoTitMedium\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/giu),
    ].map((match) => htmlText(match[1]!));
    if (mediumHeadings.some((heading) => !/^Card Text \d+$/u.test(heading))) {
      throw new AdapterParseFailure("Official Digimon Card List contains unrecognized Card text framing.");
    }
    const field = (...names: string[]): string | null => firstLabelValue(pairs, names);
    const digivolutionRequirements = pairs
      .filter(({ label }) => /^Digivolve Cost \d+$/u.test(label))
      .sort((left, right) =>
        left.label.localeCompare(right.label, "en", {
          numeric: true,
        }),
      )
      .map(({ value }, requirementIndex) => {
        const match = value.match(
          /^((?:Red|Blue|Green|Yellow|Black|Purple|White)(?:\s*\/\s*(?:Red|Blue|Green|Yellow|Black|Purple|White))*)\s+(\d+)\s+from\s+Lv\.?(\d+)$/iu,
        );
        // The live Appmon crossover printings (verified 2026-08-12 on the
        // LM-08 leaf) digivolve from publisher grade tokens with an "any
        // colours" requirement; the exact wording stays retained in
        // raw_condition and the colour set is explicitly unconstrained.
        const liveMatch =
          match === null && nestedRelatedQa
            ? value.match(
                /^(Multicolor|(?:Red|Blue|Green|Yellow|Black|Purple|White)(?:[\s/]+(?:Red|Blue|Green|Yellow|Black|Purple|White))*)\s+(\d+)\s+from\s+(?:Lv\.?(\d+)|(?:Sup|Stnd|Ult|God)\.?)$/u,
              )
            : null;
        if (match === null && liveMatch === null) {
          throw new AdapterParseFailure(`Unrecognized official Digimon digivolution requirement: ${value}`);
        }
        const chosen = match ?? liveMatch!;
        return {
          index: requirementIndex + 1,
          from_level: chosen[3] === undefined ? null : Number.parseInt(chosen[3], 10),
          colours: chosen[1] === "Multicolor" ? [] : colourValues(chosen[1]!.replace(/\s+/gu, "/")),
          cost: Number.parseInt(chosen[2]!, 10),
          raw_condition: value,
        };
      });
    // The live BT-01 listing (verified 2026-08-07) publishes vanilla Digimon
    // Cards without any effect row; restructured contracts retain them with
    // empty printed rules instead of failing the leaf.
    const effect = optionalEffect
      ? (field("[Effect]", "Effect") ?? "")
      : requiredText(field("[Effect]", "Effect"), "Official Digimon Card effect");
    const textSectionPairs = pairs.map(({ label, value }) => ({
      label:
        new Map([
          ["[Effect]", "Effect"],
          ["[Inherited Effect]", "Inherited Effect"],
          ["[Security Effect]", "Security Effect"],
        ]).get(label) ?? label,
      value,
    }));
    const imageContainer = exactDigimonClassBody(record, "div", "cardImgInner", "Official Digimon Printing image");
    const imageMatches = [...imageContainer.matchAll(/<img\b([^>]*)>/giu)];
    if (imageMatches.length !== 1) {
      throw new AdapterParseFailure("Official Digimon Printing requires one exact front image.");
    }
    const rawImageUrl = htmlAttribute(imageMatches[0]![1]!, "data-src") ?? htmlAttribute(imageMatches[0]![1]!, "src");
    const imageUrl = adapterUrl(requiredText(rawImageUrl, "Official Digimon Printing image URL"), requestUrl);
    if (!officialUrl("digimon-en", imageUrl, "image")) {
      throw new AdapterParseFailure("Official Digimon Printing image URL is not authoritative.");
    }
    const detail = canonicalDetail(
      {
        popup_id: locator,
        card_number: cardNumber,
        name: exactDigimonClassText(record, "div", "cardTitle", "Official Digimon Card name"),
        Effect: effect,
        profile: "digimon@1",
        product_codes: [],
        fuzzy_product_labels: [],
        distribution: {
          code: `listing:${adapterUrl(requestUrl).search}`,
          kind: "source_bucket",
          label: field("Notes") ?? "Digimon Card List leaf",
        },
        printing: {
          rarity: requiredText(titleField("cardRarity"), "Official Digimon Printing rarity"),
          attributes: { alternative_art: alternativeArtNumber !== undefined },
        },
        printed_rules: effect,
        variant:
          alternativeArtNumber === undefined ? "base" : `alternate-art-${Number.parseInt(alternativeArtNumber, 10)}`,
        image_url: imageUrl.href,
      },
      {
        path: "popup_id",
        number: "card_number",
        title: "name",
        rules: "Effect",
        attributes: {
          card_type: cardType,
          colours: colourValues(field("Color")),
          level,
          play_cost: integerOrNull(field("Play Cost", "Cost")),
          use_cost: integerOrNull(field("Use Cost")),
          dp: integerOrNull(field("DP")),
          form: field("Form"),
          attribute: field("Attribute"),
          traits: textValues(field("Type")),
          digivolution_requirements: digivolutionRequirements,
          text_sections: digimonTextSections(textSectionPairs),
          dual_colours: colourValues(field("DUAL Color")),
          dual_cost: integerOrNull(field("DUAL Cost")),
          link_dp: nestedRelatedQa ? digimonLinkDp(field("[Link DP]")) : integerOrNull(field("[Link DP]")),
        },
        imageFields: [{ role: "front", value: imageUrl.href }],
        preserveFuzzyProductLabels: true,
        derivePrintingIdentity: true,
        allowEmptyRules: optionalEffect,
      },
    );
    const observation = cardObservation(
      detail,
      [],
      new Map(),
      { revision: "captured-by-policy-surface", entries: [] },
      { revision: "captured-by-policy-surface", entries: [] },
      "digimon",
    );
    return attachRawSurfaceEvidenceV1(
      {
        ...observation,
        completeness: completeObservation(1, 1),
      },
      "digimon-en",
      "card-list",
      {
        popup_id: locator,
        publisher_card_type: publisherCardType,
        publisher_level: levelValue,
        leaf_cardcategory: leafPublisherCardType,
        card_qa: retainedQa.entries,
      },
      true,
      ["popup_id", "publisher_card_type", "publisher_level", "leaf_cardcategory"],
    );
  });
}

const digimonProfileCardTypes = new Map([
  ["digi-egg", "digi_egg"],
  ["digimon", "digimon"],
  ["tamer", "tamer"],
  ["option", "option"],
  ["digimon/option", "digimon_option"],
]);

function digimonProfileCardType(value: unknown, name: string): string {
  const publisherType = requiredText(value, name);
  const normalizedPublisherType = publisherType.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en");
  const profileType = digimonProfileCardTypes.get(normalizedPublisherType);
  if (profileType === undefined) {
    throw new AdapterParseFailure(`${name} is unknown.`);
  }
  return profileType;
}

function digimonCardLevel(value: string | null, cardType: string): number | null {
  if (value === null) return null;
  const normalized = value.normalize("NFKC").trim();
  if (/^(?:|-|—|n\/a|not available|unavailable)$/iu.test(normalized)) {
    return null;
  }
  const level = normalized.match(/^Lv\.(\d+)$/u)?.[1];
  if (level === undefined) {
    throw new AdapterParseFailure(`Official Digimon ${cardType} level is invalid.`);
  }
  return Number.parseInt(level, 10);
}

function digimonLinkDp(value: string | null): number | null {
  // The live Appmon crossover printings publish Link DP as an explicit
  // bonus token ("DP+3000", verified 2026-08-12 on the LM-08 leaf).
  const bonus = value
    ?.normalize("NFC")
    .trim()
    .match(/^DP\+(\d+)$/u);
  return bonus === undefined || bonus === null ? integerOrNull(value) : Number.parseInt(bonus[1]!, 10);
}

function digimonCardQa(
  infoHtml: string,
  nestedRelatedQa = false,
): {
  remainingHtml: string;
  entries: Record<string, unknown>[];
} {
  const list = nestedRelatedQa ? digimonNestedQaList(infoHtml) : digimonFlatQaList(infoHtml);
  if (list === null) return { remainingHtml: infoHtml, entries: [] };
  const { body, remainingHtml } = list;
  const starts = [...body.matchAll(/<li\b[^>]*\bclass=["'][^"']*\bcardFaqListItem\b[^"']*["'][^>]*>/giu)].map(
    (item) => item.index,
  );
  if (starts.length === 0) {
    throw new AdapterParseFailure("Official Digimon Card Q&A list is structurally empty.");
  }
  const entries = starts.map((start, index) => {
    const entry = body.slice(start, starts[index + 1] ?? body.length);
    const answerBody = exactDigimonClassBody(entry, "dd", "cardFaqAnswer", "Official Digimon Card Q&A answer");
    const related = nestedRelatedQa
      ? digimonQaRelatedCards(answerBody)
      : { answerHtml: answerBody, relatedCards: null };
    return {
      number: exactDigimonClassText(entry, "p", "cardFaqNum", "Official Digimon Card Q&A number"),
      date: digimonOptionalClassText(entry, "p", "cardFaqDate"),
      question: exactDigimonClassText(entry, "dt", "cardFaqQuestion", "Official Digimon Card Q&A question"),
      answer: requiredText(htmlText(related.answerHtml), "Official Digimon Card Q&A answer"),
      ...(related.relatedCards === null ? {} : { related_cards: related.relatedCards }),
    };
  });
  return { remainingHtml, entries };
}

function digimonFlatQaList(infoHtml: string): { body: string; remainingHtml: string } | null {
  const listMatches = [
    ...infoHtml.matchAll(/<ul\b[^>]*\bclass=["'][^"']*\bcardFaqList\b[^"']*["'][^>]*>([\s\S]*?)<\/ul>/giu),
  ];
  if (listMatches.length > 1) {
    throw new AdapterParseFailure("Official Digimon Card Q&A list is duplicated.");
  }
  const match = listMatches[0];
  if (match === undefined) return null;
  return {
    body: match[1]!,
    remainingHtml: infoHtml.replace(match[0], ""),
  };
}

function digimonNestedQaList(infoHtml: string): { body: string; remainingHtml: string } | null {
  // Live Q&A answers can nest a related-cards <ul>, so the list body must
  // end at its matching close, not at the first </ul>.
  const openings = [...infoHtml.matchAll(/<ul\b[^>]*\bclass=["'][^"']*\bcardFaqList\b[^"']*["'][^>]*>/giu)];
  if (openings.length > 1) {
    throw new AdapterParseFailure("Official Digimon Card Q&A list is duplicated.");
  }
  const opening = openings[0];
  if (opening === undefined) return null;
  const bodyStart = opening.index + opening[0].length;
  let depth = 1;
  let bodyEnd = -1;
  let listEnd = -1;
  for (const token of infoHtml.slice(bodyStart).matchAll(/<ul\b|<\/ul>/giu)) {
    depth += token[0] === "</ul>" ? -1 : 1;
    if (depth === 0) {
      bodyEnd = bodyStart + token.index;
      listEnd = bodyStart + token.index + token[0].length;
      break;
    }
  }
  if (bodyEnd < 0) {
    throw new AdapterParseFailure("Official Digimon Card Q&A list is structurally incomplete.");
  }
  return {
    body: infoHtml.slice(bodyStart, bodyEnd),
    remainingHtml: infoHtml.slice(0, opening.index) + infoHtml.slice(listEnd),
  };
}

function digimonQaRelatedCards(answerBody: string): { answerHtml: string; relatedCards: string[] } {
  const boxes = [
    ...answerBody.matchAll(/<div\b[^>]*\bclass=["'][^"']*\brelatedBox\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/giu),
  ];
  if (boxes.length === 0) return { answerHtml: answerBody, relatedCards: [] };
  if (boxes.length > 1) {
    throw new AdapterParseFailure("Official Digimon Card Q&A duplicates its related-cards evidence.");
  }
  const box = boxes[0]!;
  const boxHtml = box[0]!;
  const boxBody = box[1]!;
  if (/<div/iu.test(boxBody)) {
    throw new AdapterParseFailure("Official Digimon Card Q&A related-cards evidence is unrecognized.");
  }
  if (!/<p\b[^>]*\bclass=["'][^"']*\brelatedTit\b[^"']*["'][^>]*>\s*Related Cards\s*<\/p>/iu.test(boxBody)) {
    throw new AdapterParseFailure("Official Digimon Card Q&A related-cards evidence is unrecognized.");
  }
  const relatedCards = [
    ...boxBody.matchAll(/<a\b[^>]*\bhref=["'][^"']*[?&]free=([^"'&]+)["'&][\s\S]*?<img\b([^>]*)>/giu),
  ].map((anchor) => {
    // The live publisher occasionally pads related-card identities with an
    // ideographic space (verified 2026-08-12 on the P-numbered promo leaf).
    const locator = decodeHtmlText(anchor[1]!).normalize("NFKC").trim();
    const alt = htmlAttribute(anchor[2]!, "alt")?.normalize("NFKC").trim() ?? null;
    if (!/^[A-Z]{1,6}\d{0,3}-\d{1,5}$/u.test(locator) || alt !== locator) {
      throw new AdapterParseFailure("Official Digimon Card Q&A related-card identity is invalid.");
    }
    return locator;
  });
  if (relatedCards.length === 0) {
    throw new AdapterParseFailure("Official Digimon Card Q&A related-cards evidence is structurally empty.");
  }
  return {
    answerHtml: answerBody.replace(boxHtml, ""),
    relatedCards,
  };
}

function exactHtmlClassName(attributes: string): string | null {
  const value = htmlAttribute(attributes, "class");
  if (value === null) return null;
  const names = value.trim().split(/\s+/u).filter(Boolean);
  return names.length === 1 ? names[0]! : null;
}

function exactDigimonClassBody(
  html: string,
  tag: string,
  className: string,
  label: string,
  closingPattern?: RegExp,
): string {
  const opening = new RegExp(`<${tag}\\b([^>]*\\bclass=["'][^"']*\\b${className}\\b[^"']*["'][^>]*)>`, "giu");
  const matches = [...html.matchAll(opening)];
  if (matches.length !== 1) {
    throw new AdapterParseFailure(`${label} requires one exact ${className} container.`);
  }
  const bodyStart = matches[0]!.index + matches[0]![0].length;
  const tail = html.slice(bodyStart);
  const closing = closingPattern ?? new RegExp(`</${tag}>`, "iu");
  const close = tail.match(closing);
  if (close?.index === undefined) {
    throw new AdapterParseFailure(`${label} is structurally incomplete.`);
  }
  return tail.slice(0, close.index);
}

function exactDigimonClassText(html: string, tag: string, className: string, label: string): string {
  return requiredText(htmlText(exactDigimonClassBody(html, tag, className, label)), label);
}

function digimonOptionalClassText(html: string, tag: string, className: string): string | null {
  const matches = [
    ...html.matchAll(
      new RegExp(`<${tag}\\b[^>]*\\bclass=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)</${tag}>`, "giu"),
    ),
  ];
  if (matches.length > 1) {
    throw new AdapterParseFailure(`Official Digimon Card Q&A duplicates ${className}.`);
  }
  return matches[0] === undefined ? null : htmlText(matches[0]![1]!);
}

function parseDigimonOfficialErrata(document: Record<string, unknown>): OfficialErratumObservation[] {
  const entries = requiredArray(document.entries, "Digimon Official Errata entries");
  return entries.map((value) => {
    const entry = requiredRecord(value, "Digimon Official Erratum");
    const allowedFields = new Set([
      "card_number",
      "published_on",
      "effective_from",
      "observed_printed_rules_text",
      "corrected_rules_text",
      "official_wording",
      "applies_to_parallel_printings",
      "source_fragment",
      "display_name",
      "image_url",
    ]);
    const unknownField = Object.keys(entry).find((field) => !allowedFields.has(field));
    if (unknownField !== undefined) {
      throw new AdapterParseFailure(`Digimon Official Erratum contains unknown field ${unknownField}.`);
    }
    if (typeof entry.applies_to_parallel_printings !== "boolean") {
      throw new AdapterParseFailure("Digimon Official Erratum applies-to-parallel-printings flag is invalid.");
    }
    return {
      kind: "official_erratum",
      game: "digimon",
      target: {
        type: "card",
        official_identity: {
          kind: "card_number",
          value: requiredText(entry.card_number, "Digimon Erratum Card Number"),
        },
      },
      published_on: requiredText(entry.published_on, "Digimon Erratum published date"),
      effective_from:
        entry.effective_from === null ? null : requiredText(entry.effective_from, "Digimon Erratum effective date"),
      observed_printed_rules_text: requiredText(
        entry.observed_printed_rules_text,
        "Digimon Erratum observed Printed Rules Text",
      ),
      corrected_rules_text:
        entry.corrected_rules_text === null
          ? null
          : requiredText(entry.corrected_rules_text, "Digimon Erratum corrected Rules Text"),
      official_wording: requiredText(entry.official_wording, "Digimon Erratum official wording"),
      applies_to_parallel_printings: entry.applies_to_parallel_printings,
      source: {
        fragment: requiredText(entry.source_fragment, "Digimon Erratum source fragment"),
        display_name: requiredText(entry.display_name, "Digimon Erratum display name"),
        image_url: requiredText(entry.image_url, "Digimon Erratum image URL"),
      },
      completeness: {
        structurally_complete: true,
        required_surfaces_complete: true,
        partitions_complete: true,
        declared_record_count: 1,
        parsed_record_count: 1,
      },
    };
  });
}
