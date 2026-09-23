// Synthetic Riftbound DB census envelopes (#333). The facets and card-page
// shapes follow the retained 2026-09-14 API responses. Callers pass unchanged
// retained records; `syntheticRiftboundDbRecords` derives clearly labelled
// synthetic records from one of them when a test needs more than a page.

export const riftboundDbCensusPageSize = 80;

/** The retained facets with only their set list replaced. */
export function syntheticRiftboundDbFacets(retained, sets) {
  return JSON.stringify({ ...retained, sets });
}

/** One census page of a set bucket, in the retained `{cards, pagination}` shape. */
export function syntheticRiftboundDbCardsPage({ page, total, cards }) {
  const pages = Math.max(1, Math.ceil(total / riftboundDbCensusPageSize));
  return JSON.stringify({
    cards,
    pagination: { page, pageSize: riftboundDbCensusPageSize, total, hasMore: page < pages },
  });
}

/** Copies of a retained record with synthetic source identities and numbers. */
export function syntheticRiftboundDbRecords(template, count, prefix) {
  return Array.from({ length: count }, (_, index) => {
    const id = `synthetic-${prefix}-${index + 1}`;
    const number = String(900 + index);
    return { ...template, id, number, raw: { ...template.raw, id } };
  });
}
