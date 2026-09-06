import type { RawAdapterDefinition } from "./adapter-contract";
import {
  attachRawSurfaceEvidenceV1,
  cardObservation,
  colourValues,
  completeObservation,
  decodeHtmlText,
  exactOnePieceSourceDate,
  firstLabelValue,
  htmlAttribute,
  htmlLabelPairs,
  htmlText,
  integerOrNull,
  looseHtmlAttribute,
  productLinksFromHtml,
  requiredHtmlMatch,
  textValues,
} from "./adapter-html";
import {
  canonicalDetail,
  gundamPublisherNullableText,
  type NormalizedSurfaceBody,
  normalizedDiscovery,
  normalizedGundamRarity,
  normalizedPartitions,
  normalizedPolicy,
  normalizedSurfaceBody,
  normalizePartitionEntries,
  productReleaseNormalizers,
  requiredArray,
  requiredRecord,
  requiredText,
} from "./adapter-normalization";
import type {
  CatalogueObservation,
  OfficialErratumObservation,
  OfficialSourceObservation,
} from "./adapter-observations";
import { AdapterParseFailure, adapterUrl } from "./adapter-parse-failure";
import { parseProductDetail } from "./adapter-product-html";
import { createBandaiAdapter } from "./bandai-adapter-runtime";
import { officialSourceAuthorities, officialUrl } from "./official-source-authority";

const productRelease = productReleaseNormalizers({
  gameLabel: "Gundam",
  productCode: "productCode",
  productName: "productName",
  releaseEvent: "releaseEventId",
});
const definitions: readonly RawAdapterDefinition[] = [
  ...(
    [
      ["gundam-en-asia", "asia-en", "EN-ASIA"],
      ["gundam-en-us", "en", "EN-US"],
    ] as const
  ).map(([sourceLineage, locale, partition]) => ({
    sourceLineage,
    supportedGame: "gundam" as const,
    format: "gundam" as const,
    ...officialSourceAuthorities[sourceLineage]!,
    partition,
    reconciliationAreas: ["catalogue", "errata"] as const,
    inheritDiscoveryRequestHeaders: true,
    listingReconciliation: {
      groupsPublisherPages: true,
      strictListingIdentity: false,
      duplicateLocatorCompatibility: "never" as const,
    },
    requiredSurfaces: ["packages", "products", "releases", "errata"],
    urls: {
      packages: `https://www.gundam-gcg.com/${locale}/cards/index.php`,
      products: `https://www.gundam-gcg.com/${locale}/products/list.php`,
      releases: `https://www.gundam-gcg.com/${locale}/products/list.php`,
      // The live news hub filters through subcategory tabs; errata and
      // correction articles are published under the NEWS tab.
      errata: `https://www.gundam-gcg.com/${locale}/news/?subcategory=news&tag=all&page=1`,
    },
    version: {
      adapterVersion: `${sourceLineage}@7`,
      parserContract: `${sourceLineage}-restructured-complete-catalogue@6`,
      expandedOnePieceCatalogue: false,
      catalogueComplete: true,
      completeDigimonCatalogue: false,
      optionalCardFields: false,
      liveShapes: false,
    },
  })),
];
export const gundamAdapters = definitions.map((definition) =>
  createBandaiAdapter(definition, (lineage, surface, raw) => normalizeGundamSurface(lineage, surface, raw, true), {
    productDetail: (html, lineage, url) =>
      parseProductDetail(
        html,
        {
          titleSuffix: /\s*[|｜]\s*GUNDAM CARD GAME Official Website$/u,
          seasonPrecisionReleases: false,
          validateTitle: validateGundamProductTitle,
        },
        lineage,
        url,
      ),
    structuredObservations: (surface, document, lineage) =>
      surface === "errata" ? gundamOfficialErrataObservations(document, lineage) : [],
    packageOptions: gundamPublisherPackageOptions,
    packagesRoot: parseRestructuredGundamPackagesRoot,
    cardDetail: parseGundamCardDetailHtmlV4,
    errataArticle: parseGundamOfficialErrataHtmlV4,
  }),
);

function normalizeGundamSurface(
  sourceLineage: string,
  surface: string,
  raw: Record<string, unknown>,
  catalogueComplete = false,
): NormalizedSurfaceBody {
  const expectedLocale = sourceLineage === "gundam-en-asia" ? "EN-ASIA" : "EN-US";
  if (raw.locale !== expectedLocale) {
    throw new AdapterParseFailure("Gundam surface locale does not match its Source Lineage.");
  }
  if (surface === "packages") {
    if (raw.view !== "card-search") {
      throw new AdapterParseFailure("Gundam card-search view identity is invalid.");
    }
    return normalizedSurfaceBody(
      normalizedDiscovery(
        raw.package_options,
        raw.result,
        normalizeGundamDetails(raw.card_details, catalogueComplete),
        productRelease.products(raw.products),
        productRelease.releases(raw.releases),
        "package=all",
        exactGundamLeaves(raw.package_options),
      ),
      ["view", "locale", "package_options", "result", "card_details", "products", "releases"],
    );
  }
  if (surface === "products") {
    if (raw.view !== "product-list") {
      throw new AdapterParseFailure("Gundam Product list identity is invalid.");
    }
    return normalizedSurfaceBody(
      normalizedPartitions(normalizePartitionEntries(raw.result, productRelease.product), "package"),
      ["view", "locale", "result"],
    );
  }
  if (surface === "releases") {
    if (raw.publication !== "locale-product-release-dates") {
      throw new AdapterParseFailure("Gundam Release publication identity is invalid.");
    }
    return normalizedSurfaceBody(
      normalizedPartitions(normalizePartitionEntries(raw.events, productRelease.releaseEntry), "release-event"),
      ["publication", "locale", "events"],
    );
  }
  return normalizedSurfaceBody(normalizedPolicy(raw, `gundam-${surface}`), [
    "publication",
    "locale",
    "revision",
    "declared_record_count",
    "partition",
    "entries",
  ]);
}

function exactGundamLeaves(value: unknown): string[] {
  return requiredArray(value, "Gundam package vocabulary").map((item) => {
    if (typeof item === "string") {
      return `package=${requiredText(item, "Gundam package")}`;
    }
    const record = requiredRecord(item, "Gundam package");
    return `package=${requiredText(record.value, "Gundam package value")}`;
  });
}

function normalizeGundamDetails(value: unknown, completeCatalogue = false): unknown[] {
  return requiredArray(value, "Gundam Card details").map((item) => {
    const card = requiredRecord(item, "Gundam Card detail");
    const printing = card.printing === undefined ? undefined : requiredRecord(card.printing, "Gundam Printing fields");
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
        block_icon: completeCatalogue ? gundamPublisherNullableText(card.Block) : card.Block,
        effect_text: card.Effect,
        zone: completeCatalogue ? gundamPublisherNullableText(card.Zone) : card.Zone,
        traits: card.Trait,
        link_condition: completeCatalogue ? gundamPublisherNullableText(card.Link) : card.Link,
        ap: card.AP,
        hp: card.HP,
        series_titles: card.Title,
      },
      imageFields: [{ role: "front", value: card.image_url }],
      normalizedRarity: completeCatalogue ? normalizedGundamRarity(printing?.rarity ?? null) : undefined,
      derivePrintingIdentity: completeCatalogue,
    });
  });
}

function parseGundamCardDetailHtmlV4(html: string, sourceLineage: string, requestUrl: string): CatalogueObservation {
  const url = adapterUrl(requestUrl);
  const entries = [...url.searchParams.entries()];
  if (
    entries.length !== 1 ||
    entries[0]![0] !== "detailSearch" ||
    !/^[A-Z0-9]+(?:-[A-Z0-9]+)+(?:_p[1-9]\d*)?$/u.test(entries[0]![1])
  ) {
    throw new AdapterParseFailure("Official Gundam detail full locator is invalid.");
  }
  const locator = entries[0]![1];
  const locatorMatch = locator.match(/^([A-Z0-9]+(?:-[A-Z0-9]+)+)((?:_p[1-9]\d*)?)$/u)!;
  const expectedCardNumber = locatorMatch[1]!;
  const variant = locatorMatch[2] || "base";
  const pairs = htmlLabelPairs(html);
  const field = (names: readonly string[]): string | null => firstLabelValue(pairs, names);
  const cardNumber = gundamDetailClassText(html, "cardNo", "Card Number");
  if (cardNumber !== expectedCardNumber) {
    throw new AdapterParseFailure("Official Gundam detail Card Number does not match its full locator.");
  }
  const name = gundamDetailClassText(html, "cardName", "Card name");
  const rarity = gundamDetailClassText(html, "rarity", "rarity");
  const blockIcon = gundamDetailClassText(html, "blockIcon", "Block icon");
  const cardType = requiredText(field(["TYPE", "Type"]), "Gundam Card Type");
  const colour = requiredText(field(["COLOR", "Color"]), "Gundam Color");
  const overview = html.match(
    /<div\b[^>]*\bclass=["'][^"']*\bcardDataRow\b[^"']*\boverview\b[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<\/div>/iu,
  );
  const rules = requiredText(htmlText(overview?.[1] ?? ""), "Gundam Card Effect");
  const cardImage = html.match(/<div\b[^>]*\bclass=["'][^"']*\bcardImage\b[^"']*["'][^>]*>[\s\S]*?<img\b([^>]*)>/iu);
  const rawImage = cardImage === null ? null : looseHtmlAttribute(cardImage[1]!, "src");
  if (rawImage === null) {
    throw new AdapterParseFailure("Official Gundam detail has no Printing Image URL.");
  }
  const imageUrl = adapterUrl(decodeHtmlText(rawImage), requestUrl);
  if (!officialUrl(sourceLineage, imageUrl, "image")) {
    throw new AdapterParseFailure("Official Gundam detail Printing Image URL is invalid.");
  }
  const expectedImageLocator = imageUrl.pathname.match(
    /\/([A-Z0-9]+(?:-[A-Z0-9]+)+(?:_p[1-9]\d*)?)\.(?:avif|gif|jpe?g|png|webp)$/iu,
  )?.[1];
  if (expectedImageLocator !== locator) {
    throw new AdapterParseFailure("Official Gundam detail Printing Image does not match its full locator.");
  }
  const productLinks = productLinksFromHtml(html, requestUrl);
  const products = productLinks.products;
  const distribution =
    products.length === 0
      ? {
          code: `detail:${url.pathname}`,
          kind: "source_bucket",
          label: field(["Where to get it"]) ?? "Card detail",
        }
      : {
          code: `product:${products[0]!.code}`,
          kind: "product",
          label: products[0]!.title,
          product_reference: {
            kind: "official_code",
            value: products[0]!.code,
          },
        };
  const alternateArt = variant !== "base";
  const detail = {
    ...canonicalDetail(
      {
        detailSearch: locator,
        card_number: cardNumber,
        name,
        Effect: rules,
        profile: "gundam@1",
        product_codes: products.map(({ code }) => code),
        fuzzy_product_labels: productLinks.fuzzyLabels,
        distribution,
        printing: {
          rarity,
          attributes: { alternate_art: alternateArt },
        },
        printed_rules: rules,
        variant,
        image_url: imageUrl.href,
      },
      {
        path: "detailSearch",
        number: "card_number",
        title: "name",
        rules: "Effect",
        attributes: {
          card_type: cardType.toLowerCase().replace(/\s+/gu, "_"),
          colours: colour === "-" ? [] : colourValues(colour),
          level: integerOrNull(field(["Lv.", "Lv", "Level"])),
          cost: integerOrNull(field(["COST", "Cost"])),
          block_icon: gundamPublisherNullableText(blockIcon),
          effect_text: rules,
          zone: gundamPublisherNullableText(field(["Zone"])),
          traits: textValues(field(["Trait", "Traits"])),
          link_condition: gundamPublisherNullableText(field(["Link"])),
          ap: integerOrNull(field(["AP"])),
          hp: integerOrNull(field(["HP"])),
          series_titles: textValues(field(["Source Title", "Title"])),
        },
        printingAttributes: { alternate_art: alternateArt },
        normalizedRarity: normalizedGundamRarity(rarity),
        imageFields: [{ role: "front", value: imageUrl.href }],
        preserveFuzzyProductLabels: true,
        derivePrintingIdentity: true,
      },
    ),
    treatment: alternateArt ? "alternate" : "standard",
  };
  const observation = cardObservation(
    detail,
    products,
    new Map(),
    { revision: "captured-by-policy-surface", entries: [] },
    "gundam",
  );
  const retainedDocument = Object.fromEntries([
    ...pairs.map(({ label, value }) => [label, value] as const),
    ["Card Number", cardNumber],
    ["Card Name", name],
    ["Rarity", rarity],
    ["Block icon", blockIcon],
    ["Effect", rules],
    ["Full locator", locator],
    ["Printing Image URL", imageUrl.href],
  ]);
  return attachRawSurfaceEvidenceV1(
    observation,
    sourceLineage,
    "card-detail",
    retainedDocument,
    true,
    Object.keys(retainedDocument),
  );
}

function gundamDetailClassText(html: string, className: string, field: string): string {
  const matches = [
    ...html.matchAll(
      new RegExp(`<[^>]+\\bclass=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, "giu"),
    ),
  ];
  if (matches.length !== 1) {
    throw new AdapterParseFailure(`Official Gundam detail ${field} is incomplete.`);
  }
  return requiredText(htmlText(matches[0]![1]!), `Gundam ${field}`);
}

function parseGundamOfficialErrataHtmlV4(
  html: string,
  sourceLineage: string,
  requestUrl: string,
): readonly OfficialSourceObservation[] {
  const titleMatch = html.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/iu);
  const title = htmlText(titleMatch?.[1] ?? "");
  if (!/\b(?:errata|revision|correction)\b/iu.test(title)) {
    throw new AdapterParseFailure("Gundam Errata title authority is invalid.");
  }
  const dateMatch = html.match(/<div\b[^>]*\bclass=["'][^"']*\bdate\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/iu);
  const publishedOn = exactGundamArticleDate(htmlText(dateMatch?.[1] ?? ""));
  const bodyStart = html.search(/<div\b[^>]*\bclass=["'][^"']*\barticleBody\b[^"']*["'][^>]*>/iu);
  if (bodyStart < 0) {
    throw new AdapterParseFailure("Gundam Errata article body is unavailable.");
  }
  let body = html.slice(bodyStart);
  if (sourceLineage === "gundam-en-asia") {
    const english = body.search(/<h6\b[^>]*>\s*English Version\s*<\/h6>/iu);
    if (english < 0) {
      throw new AdapterParseFailure("Gundam Asia Errata English Version is unavailable.");
    }
    body = body.slice(english);
  }
  const headings = [
    ...body.matchAll(
      /<span\b(?=[^>]*\bstyle=["'][^"']*\bfont-size\s*:\s*1\.25em\b[^"']*["'])[^>]*>([\s\S]*?)<\/span>/giu,
    ),
  ].map((match) => {
    const heading = htmlText(match[1]!);
    const cardNumber = heading.match(/^([A-Z]{1,5}[0-9]{0,3}-[A-Z0-9]{1,6})(?:\s|$)/u)?.[1];
    if (cardNumber === undefined) {
      throw new AdapterParseFailure("Gundam Errata Card heading identity is invalid.");
    }
    return { cardNumber, index: match.index };
  });
  const beforeCount = [...body.matchAll(/<h5\b[^>]*>[\s\S]*?\bBefore\b[\s\S]*?<\/h5>/giu)].length;
  const afterCount = [...body.matchAll(/<h5\b[^>]*>[\s\S]*?\bAfter\b[\s\S]*?<\/h5>/giu)].length;
  if (
    headings.length === 0 ||
    headings.length !== beforeCount ||
    headings.length !== afterCount ||
    new Set(headings.map(({ cardNumber }) => cardNumber)).size !== headings.length
  ) {
    throw new AdapterParseFailure("Gundam Errata correction inventory is incomplete.");
  }
  const entries = headings.map((heading, index) => {
    const segment = body.slice(heading.index, headings[index + 1]?.index ?? body.length);
    const before = gundamErrataHtmlField(segment, "Before");
    const after = gundamErrataHtmlField(segment, "After");
    const imageMatches = [...segment.matchAll(/<img\b([^>]*)>/giu)].flatMap((match) => {
      const rawUrl = looseHtmlAttribute(match[1]!, "src");
      if (rawUrl === null) return [];
      const imageUrl = adapterUrl(decodeHtmlText(rawUrl), requestUrl);
      return imageUrl.pathname.includes(heading.cardNumber) ? [imageUrl] : [];
    });
    if (imageMatches.length !== 1 || !officialUrl(sourceLineage, imageMatches[0]!, "image")) {
      throw new AdapterParseFailure("Gundam Errata correction image is incomplete.");
    }
    return {
      cardNumber: heading.cardNumber,
      before,
      after,
      imageUrl: imageMatches[0]!.href,
    };
  });
  const qualifiers = [...body.matchAll(/<strong\b[^>]*>([\s\S]*?)<\/strong>/giu)]
    .map((match) => htmlText(match[1]!))
    .filter((wording) => /\bcorrect wording\b/iu.test(wording));
  if (qualifiers.length !== 1) {
    throw new AdapterParseFailure("Gundam Errata correction qualifier is incomplete.");
  }
  const articleId = adapterUrl(requestUrl)
    .pathname.split("/")
    .at(-1)!
    .replace(/\.html$/u, "");
  const notice = qualifiers[0]!;
  const appliesToParallelPrintings =
    /^For the applicable cards, the above shall be regarded as the correct wording\.?$/iu.test(notice);
  return gundamOfficialErrataObservations(
    {
      entries: entries.map((entry) => ({
        entry_id: `gundam-${articleId}-${entry.cardNumber.toLowerCase()}`,
        card_number: entry.cardNumber,
        published_on: publishedOn,
        effective_from: null,
        before: entry.before,
        after: entry.after,
        notice,
        applies_to_parallel_printings: appliesToParallelPrintings,
        image_url: entry.imageUrl,
      })),
    },
    sourceLineage,
  );
}

function gundamErrataHtmlField(segment: string, label: "Before" | "After"): string {
  const expression = new RegExp(
    `<h5\\b[^>]*>[\\s\\S]*?\\b${label}\\b[\\s\\S]*?<\\/h5>` +
      `[\\s\\S]*?<div\\b[^>]*\\bclass=["'][^"']*\\btext-area\\b[^"']*["'][^>]*>` +
      `([\\s\\S]*?)<\\/div>`,
    "iu",
  );
  const matches = [...segment.matchAll(new RegExp(expression.source, "giu"))];
  if (matches.length !== 1) {
    throw new AdapterParseFailure("Gundam Errata correction inventory is incomplete.");
  }
  return requiredText(htmlText(matches[0]![1]!), `Gundam Erratum ${label} text`);
}

function exactGundamArticleDate(value: string): string {
  const match = value.match(
    /^(January|February|March|April|May|June|July|August|September|October|November|December) ([1-9]|[12][0-9]|3[01]), ([0-9]{4})$/u,
  );
  if (match === null) throw new AdapterParseFailure("Gundam Errata publication date is invalid.");
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  const month = String(months.indexOf(match[1]!) + 1).padStart(2, "0");
  const day = match[2]!.padStart(2, "0");
  return exactOnePieceSourceDate(`${match[3]}-${month}-${day}`, "Gundam Erratum publication date");
}

function parseRestructuredGundamPackagesRoot(
  html: string,
  sourceLineage: string,
  surface: string,
  requestUrl: string,
): CatalogueObservation {
  const errorSections = [
    ...html.matchAll(/<section\b[^>]*\bclass=["'][^"']*\berrorCol\b[^"']*["'][^>]*>([\s\S]*?)<\/section>/giu),
  ];
  if (errorSections.length !== 1) {
    throw new AdapterParseFailure("Official Source Gundam card search root did not retain its empty search state.");
  }
  const errorTitle = htmlText(
    requiredHtmlMatch(
      errorSections[0]![1]!,
      /<h4\b[^>]*\bclass=["'][^"']*\berrorTit\b[^"']*["'][^>]*>([\s\S]*?)<\/h4>/iu,
      "Official Source Gundam card search empty state",
    )[1]!,
  );
  if (errorTitle !== "Please specify your search criteria.") {
    throw new AdapterParseFailure("Official Source Gundam card search root empty state is unrecognized.");
  }
  const packageOptions = gundamPublisherPackageOptions(html);
  if (packageOptions.length === 0) {
    throw new AdapterParseFailure("Official Source Gundam card search root enumerates no packages.");
  }
  return attachRawSurfaceEvidenceV1(
    {
      completeness: completeObservation(packageOptions.length, packageOptions.length),
      product_release_catalogue: {
        products: [],
        distribution_contexts: [],
        relationships: [],
      },
    },
    sourceLineage,
    surface,
    {
      source_lineage: sourceLineage,
      surface,
      url: requestUrl,
      empty_search_state: errorTitle,
      package_options: [...packageOptions].sort(),
    },
    true,
    ["source_lineage", "surface", "url", "empty_search_state", "package_options"],
  );
}

function gundamOfficialErrataObservations(
  document: Record<string, unknown>,
  sourceLineage: string,
): OfficialErratumObservation[] {
  const entries = requiredArray(document.entries, "Gundam Errata entries");
  return entries.map((value) => {
    const entry = requiredRecord(value, "Gundam Erratum");
    const allowed = new Set([
      "entry_id",
      "card_number",
      "published_on",
      "effective_from",
      "before",
      "after",
      "notice",
      "applies_to_parallel_printings",
      "image_url",
    ]);
    const unknown = Object.keys(entry).find((field) => !allowed.has(field));
    if (unknown !== undefined) {
      throw new AdapterParseFailure(`Gundam Erratum contains unknown field ${unknown}.`);
    }
    for (const field of allowed) {
      if (!Object.hasOwn(entry, field)) {
        throw new AdapterParseFailure(`Gundam Erratum is missing field ${field}.`);
      }
    }
    const entryId = requiredText(entry.entry_id, "Gundam Erratum identity");
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]+$/u.test(entryId)) {
      throw new AdapterParseFailure("Gundam Erratum identity is invalid.");
    }
    const cardNumber = requiredText(entry.card_number, "Gundam Erratum Card Number");
    if (!/^[A-Z]{1,5}[0-9]{0,3}-[A-Z0-9]{1,6}$/u.test(cardNumber)) {
      throw new AdapterParseFailure(`Gundam Erratum Card Number ${cardNumber} is invalid.`);
    }
    const publishedOn = exactOnePieceSourceDate(entry.published_on, "Gundam Erratum published date");
    const effectiveFrom =
      entry.effective_from === null
        ? null
        : exactOnePieceSourceDate(entry.effective_from, "Gundam Erratum effective date");
    const before = requiredText(entry.before, "Gundam Erratum Before text");
    const after = requiredText(entry.after, "Gundam Erratum After text");
    const notice = requiredText(entry.notice, "Gundam Erratum notice");
    if (typeof entry.applies_to_parallel_printings !== "boolean") {
      throw new AdapterParseFailure("Gundam Erratum parallel Printing applicability is invalid.");
    }
    const imageUrl = adapterUrl(requiredText(entry.image_url, "Gundam Erratum image URL"));
    if (!officialUrl(sourceLineage, imageUrl, "image")) {
      throw new AdapterParseFailure("Gundam Erratum image provenance is invalid.");
    }
    return {
      kind: "official_erratum",
      game: "gundam",
      target: {
        type: "card",
        official_identity: { kind: "card_number", value: cardNumber },
      },
      published_on: publishedOn,
      effective_from: effectiveFrom,
      observed_printed_rules_text: before,
      corrected_rules_text: after,
      official_wording: `Before: ${before}\nAfter: ${after}\nNote: ${notice}`,
      applies_to_parallel_printings: entry.applies_to_parallel_printings,
      source: {
        fragment: `#${entryId}`,
        display_name: cardNumber,
        image_url: imageUrl.href,
      },
      completeness: completeObservation(1, 1),
    };
  });
}

function validateGundamProductTitle(html: string, title: string, sourceLineage: string): void {
  const headings = [...html.matchAll(/<h2 class="(?:mvColTitle|titleColInnerHead)">([\s\S]*?)<\/h2>/gu)].map((match) =>
    htmlText(match[1]!),
  );
  if (headings.length !== 1 || headings[0] !== title) {
    throw new AdapterParseFailure(`${sourceLineage} Product detail heading does not match its official title.`);
  }
}

function gundamPublisherPackageOptions(html: string): string[] {
  return [
    ...new Set(
      [...html.matchAll(/<a\b([^>]*)>/giu)].flatMap((match) => {
        const attributes = match[1]!;
        const classes = htmlAttribute(attributes, "class")?.split(/\s+/u) ?? [];
        if (!classes.includes("js-selectBtn-package")) return [];
        const value = htmlAttribute(attributes, "data-val")?.trim();
        return value === undefined || value.length === 0 ? [] : [value];
      }),
    ),
  ];
}
