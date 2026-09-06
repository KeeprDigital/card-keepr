import {
  attachRawSurfaceEvidenceV1,
  completeObservation,
  decodeHtmlText,
  firstLabelValue,
  htmlAttribute,
  htmlLabelPairs,
  htmlText,
  liveOfficialProductCode,
  liveOfficialReleaseDateText,
  nonCardProductClassification,
  nonCardProductClassificationV2,
  productEventKey,
  productMapKey,
  productOnlyObservation,
} from "./adapter-html";
import type { CatalogueObservation } from "./adapter-observations";
import { AdapterParseFailure, adapterUrl } from "./adapter-parse-failure";
import {
  normalizedOfficialReleaseDate,
  normalizedOfficialReleaseStatus,
  officialReleaseDateNeedsSchemaReview,
  officialReleaseStatusNeedsSchemaReview,
} from "./official-source-release-normalization";
export type ProductDetailFields = {
  titleSuffix: RegExp;
  seasonPrecisionReleases: boolean;
  validateTitle?: (html: string, title: string, sourceLineage: string) => void;
};

export function parseProductDetail(
  html: string,
  fields: ProductDetailFields,
  sourceLineage: string,
  requestUrl: string,
): CatalogueObservation {
  const pairs = htmlLabelPairs(html);
  const field = (...names: string[]): string | null => firstLabelValue(pairs, names);
  const title = liveOfficialProductTitle(html, fields, sourceLineage);
  const nonCardClassification = nonCardProductClassificationV2(`${requestUrl} ${title}`);
  const rawDocument = {
    document_title: title,
    ...Object.fromEntries(pairs.map(({ label, value }) => [label, value])),
  };
  if (nonCardClassification !== null) {
    return attachRawSurfaceEvidenceV1(
      {
        completeness: completeObservation(),
        product_release_catalogue: {
          products: [],
          distribution_contexts: [
            {
              key: `non-card:${nonCardClassification}:${title.normalize("NFC").trim().toLocaleLowerCase()}`,
              kind: "other",
              label: nonCardClassification,
              evidence_category: "explicit",
            },
          ],
          relationships: [],
        },
      },
      sourceLineage,
      "product-detail",
      rawDocument,
      true,
      ["document_title", "Product Code"],
    );
  }
  const code = liveOfficialProductCode(title);
  const product = { code, title };
  const releaseDateText = field("Release Date", "Available Date", "On Sale") ?? liveInlineOfficialReleaseDate(html);
  const releaseStatus = field("Status");
  const releases = new Map<string, Record<string, unknown>[]>();
  if (releaseDateText !== null) {
    const releaseEvidence = liveOfficialReleaseDateEvidence(releaseDateText);
    const date = normalizedOfficialReleaseDate(releaseEvidence.date, {
      seasons: fields.seasonPrecisionReleases,
    });
    releases.set(productMapKey(product), [
      {
        event_key: productEventKey("product-release", product),
        region:
          releaseEvidence.region ?? normalizedOfficialRegion(field("Region", "Market", "Territory"), sourceLineage),
        precision: date.precision,
        date: date.value,
        status: normalizedOfficialReleaseStatus(releaseStatus),
      },
    ]);
  }
  const observation = productOnlyObservation(product, releases, {
    revision: "captured-by-policy-surface",
    entries: [],
  });
  return attachRawSurfaceEvidenceV1(observation, sourceLineage, "product-detail", rawDocument, true, [
    "document_title",
    "Product Code",
    ...(officialReleaseDateNeedsSchemaReview(releaseDateText) ? [] : ["Release Date", "Available Date", "On Sale"]),
    "Region",
    "Market",
    "Territory",
    ...(officialReleaseStatusNeedsSchemaReview(releaseStatus) ? [] : ["Status"]),
  ]);
}

function liveOfficialProductTitle(html: string, fields: ProductDetailFields, sourceLineage: string): string {
  // The live product pages publish their identity through the document
  // title with an exact per-publisher suffix; the leading <h1> is the site
  // logo on every current page.
  const rawTitle = htmlText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/iu)?.[1] ?? "");
  const suffix = fields.titleSuffix;
  if (!suffix.test(rawTitle)) {
    throw new AdapterParseFailure(`${sourceLineage} Product detail is missing its official title.`);
  }
  const title = rawTitle.replace(suffix, "").trim();
  if (title.length === 0) {
    throw new AdapterParseFailure(`${sourceLineage} Product detail is missing its official title.`);
  }
  fields.validateTitle?.(html, title, sourceLineage);
  return title;
}

function liveInlineOfficialReleaseDate(html: string): string | null {
  const match = html.match(/Release Date:\s*([^<]+)</iu);
  if (match === null) return null;
  const value = htmlText(match[1]!);
  return value.length === 0 ? null : value;
}

function liveOfficialReleaseDateEvidence(value: string): {
  date: string;
  region: "EN-OCEANIA" | null;
} {
  // The live Digimon product pages publish region-scoped release rows such
  // as "Europe/Oceania: December 10, 2021 (*Asmodee UK/Blackfire Stores:
  // January 21, 2021)"; store-level parentheticals are annotations, not
  // publisher release events.
  let normalized = value
    .normalize("NFC")
    .replace(/\(\*[^)]*\)/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  let region: "EN-OCEANIA" | null = null;
  const scoped = normalized.match(/^Europe\/Oceania:\s*(.*)$/iu);
  if (scoped !== null) {
    region = "EN-OCEANIA";
    normalized = scoped[1]!.trim();
  }
  return { date: liveOfficialReleaseDateText(normalized), region };
}

function normalizedOfficialRegion(
  value: string | null,
  sourceLineage: string,
): "EN-OCEANIA" | "EN-ASIA" | "EN-US" | "unknown" {
  const normalized = value?.normalize("NFC").trim().toLocaleLowerCase() ?? "";
  if (/^(?:en[- ]?us|us|usa|united states|north america)$/u.test(normalized)) {
    return "EN-US";
  }
  if (/^(?:en[- ]?asia|asia|south east asia|southeast asia)$/u.test(normalized)) {
    return "EN-ASIA";
  }
  if (/^(?:en[- ]?oceania|oceania|australia|australia\/new zealand)$/u.test(normalized)) {
    return "EN-OCEANIA";
  }
  if (normalized.length === 0) {
    if (sourceLineage === "gundam-en-us") return "EN-US";
    if (sourceLineage === "gundam-en-asia") return "EN-ASIA";
  }
  return "unknown";
}

export function parseBandaiProductIndex(html: string, requestUrl: string): CatalogueObservation[] {
  type ProductIndexEntry =
    | {
        product: {
          code: string | null;
          title: string;
          distribution: {
            code: string;
            kind: string;
            label: string;
          };
        };
        announced: boolean;
      }
    | {
        non_card_context: {
          key: string;
          kind: string;
          label: string;
          evidence_category: "explicit";
        };
      };
  const containers = [...html.matchAll(/<(article|li|tr)\b([^>]*)>([\s\S]*?)<\/\1>/giu)].map((match) => ({
    attributes: match[2]!,
    body: match[3]!,
  }));
  if (containers.length === 0) {
    containers.push(
      ...[...html.matchAll(/<a\b[^>]*\bhref=["'][^"']+["'][^>]*>[\s\S]*?<\/a>/giu)].map((match) => ({
        attributes: "",
        body: match[0]!,
      })),
    );
  }
  const entries = containers.flatMap<ProductIndexEntry>(({ attributes, body }) => {
    const link = body.match(/<a\b([^>]*\bhref=["'][^"']+["'][^>]*)>([\s\S]*?)<\/a>/iu);
    if (link === null) return [];
    const href = htmlAttribute(link[1]!, "href");
    if (href === null || !/\/products?\//iu.test(href)) return [];
    const title = htmlText(link[2]!);
    const resolved = adapterUrl(decodeHtmlText(href), requestUrl);
    const code =
      htmlAttribute(link[1]!, "data-product-code")?.normalize("NFC").trim() ??
      firstLabelValue(htmlLabelPairs(body), ["Product Code"]);
    if (title.length === 0) return [];
    const classificationText = `${attributes} ${body} ${resolved.pathname}`;
    const nonCardClassification = nonCardProductClassification(classificationText);
    const nonCard = nonCardClassification !== null;
    const cardBearing = /(?:booster|starter|deck|card|set)/iu.test(classificationText);
    const classification = nonCard
      ? { kind: "other", label: nonCardClassification }
      : cardBearing
        ? { kind: "product", label: "booster" }
        : { kind: "other", label: "other" };
    if (nonCard || !cardBearing) {
      return [
        {
          non_card_context: {
            key: `non-card:${classification.label}:${(code ?? title).normalize("NFC").trim().toLocaleLowerCase()}`,
            ...classification,
            evidence_category: "explicit",
          },
        },
      ];
    }
    const product = {
      code: code === null || code.length === 0 ? null : code,
      title,
    };
    return [
      {
        product: {
          ...product,
          distribution: {
            code: `product-classification:${classification.label}:${productMapKey(product)}`,
            ...classification,
          },
        },
        announced: /(?:coming soon|upcoming|announced)/iu.test(htmlText(body)),
      },
    ];
  });
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
    const { product, announced } = entry;
    const releases = new Map<string, Record<string, unknown>[]>();
    if (announced) {
      releases.set(productMapKey(product), [
        {
          event_key: productEventKey("product-index-announcement", product),
          region: "unknown",
          precision: "unknown",
          date: null,
          status: "announced",
        },
      ]);
    }
    return productOnlyObservation(product, releases, { revision: "captured-by-policy-surface", entries: [] });
  });
}
