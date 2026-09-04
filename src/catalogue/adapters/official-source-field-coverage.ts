const knownFields = new Set([
  "announcement_id",
  "ap",
  "artwork_fingerprint",
  "attribute",
  "attributes",
  "battle_attributes",
  "block_icon",
  "block_icons",
  "bucket",
  "calendarEntryId",
  "card_details",
  "card_index",
  "card_number",
  "card_pages",
  "card_popups",
  "card_type",
  "cardcategory",
  "cards",
  "category",
  "code",
  "color",
  "colour",
  "colours",
  "combo_power",
  "cost",
  "count",
  "counter",
  "date",
  "detail",
  "detailSearch",
  "detail_pages",
  "detail_path",
  "digivolution_requirements",
  "distribution",
  "dp",
  "dual_colours",
  "dual_cost",
  "effect_text",
  "entries",
  "facets",
  "filters",
  "form",
  "has_next",
  "hp",
  "image",
  "image_url",
  "image_urls",
  "kind",
  "label",
  "leader_faces",
  "level",
  "life",
  "link_condition",
  "link_dp",
  "name",
  "normalizedRarity",
  "normalized_rarity",
  "number",
  "package_options",
  "page",
  "page_info",
  "pages",
  "partitions",
  "path",
  "play_cost",
  "popup_id",
  "power",
  "precision",
  "printed_fields_digest",
  "printed_rules",
  "printing",
  "product",
  "productCode",
  "productId",
  "productName",
  "productTitle",
  "product_code",
  "product_codes",
  "product_name",
  "products",
  "rarity",
  "region",
  "release",
  "releaseEventId",
  "releaseId",
  "result_cap",
  "revision",
  "role",
  "rules",
  "series_options",
  "sha256",
  "skills",
  "skills_text",
  "source_record_id",
  "special_traits",
  "specified_cost",
  "status",
  "text",
  "text_sections",
  "title",
  "total",
  "traits",
  "trigger_text",
  "url",
  "use_cost",
  "value",
  "variant",
  "version_options",
  "zone",
]);

export type RawLeaf = { path: string; value: unknown };

export function partitionMappedOfficialLeaves(
  value: unknown,
  path: string,
): { consumed: string[]; unmapped: RawLeaf[] } {
  const rootDepth = path.split(".").length;
  const consumed: string[] = [];
  const unmapped: RawLeaf[] = [];
  for (const leaf of leafEntries(value, path)) {
    const nestedFields = leaf.path
      .replaceAll(/\[\d+\]/gu, "")
      .split(".")
      .slice(rootDepth);
    if (nestedFields.every((field) => knownFields.has(field))) {
      consumed.push(leaf.path);
    } else {
      unmapped.push(leaf);
    }
  }
  return { consumed, unmapped };
}

function leafEntries(value: unknown, path: string): RawLeaf[] {
  if (Array.isArray(value)) {
    return value.length === 0
      ? [{ path, value }]
      : value.flatMap((item, index) => leafEntries(item, `${path}[${index}]`));
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    return entries.length === 0
      ? [{ path, value }]
      : entries.flatMap(([field, item]) => leafEntries(item, `${path}.${field}`));
  }
  return [{ path, value }];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
