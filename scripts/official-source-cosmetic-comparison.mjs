const fusionProductCaptures = new Set([
  "fusion-world-en-products-hub.json",
  "fusion-world-en-products-page2.json",
  "fusion-world-en-products-starter-tag.json",
]);

const decorativeThumbnails = new Set([
  "https://www.gundam-gcg.com/gcg/bccard/asia-en/news/2026/06/01/8v5CTEcRpLBTfoj1/thumb_03.webp",
  "https://www.gundam-gcg.com/gcg/bccard/asia-en/news/2026/06/01/oMeHYhGI0rtGxXGo/thumb_01.webp",
  "https://www.gundam-gcg.com/gcg/bccard/asia-en/news/2026/06/01/Ym3S2PegVz3yiaR7/thumb_02.webp",
]);

// Comparison-only equivalences reviewed from complete repeated captures. Call
// only after the original bytes have parsed successfully; retain their outputs.
export function reviewedCosmeticComparison({ name, baseline, actual, expected, observed, observe }) {
  if (fusionProductCaptures.has(name)) {
    return {
      rule: "Fusion exact Product item permutation within the same publisher status section; every item byte retained.",
      expected: observe(sortedFusionProductItems(baseline.bytes), baseline.content_type),
      observed: observe(sortedFusionProductItems(actual.bytes), actual.content_type),
    };
  }
  if (name === "gundam-en-asia-errata-listing.json") {
    return {
      rule: "Version token on three reviewed decorative collaboration thumbnails; Printing Image URLs remain exact.",
      expected: stableDecorativeThumbnailTokens(expected),
      observed: stableDecorativeThumbnailTokens(observed),
    };
  }
  return null;
}

function sortedFusionProductItems(bytes) {
  return Buffer.from(
    bytes.toString("utf8").replace(
      /(<section class="contentsColInner (?:availableCol" id="available|comingsoonCol" id="comingsoon)">)([\s\S]*?)(<\/section>)/gu,
      (_, open, section, close) =>
        open +
        section.replace(/(<ul class="prpductList">)([\s\S]*?)(<\/ul>)/gu, (_, listOpen, items, listClose) => {
          const pattern = /<li class="prpductListItem cardCol">[\s\S]*?<\/li>/gu;
          const completeItems = items.match(pattern) ?? [];
          // Refuse unknown/nested list structure rather than discarding bytes.
          if (
            !completeItems.length ||
            items.replace(pattern, "").trim() ||
            completeItems.some((item) => /<li\b/u.test(item.slice(3)))
          )
            return listOpen + items + listClose;
          return listOpen + completeItems.sort().join("\n") + listClose;
        }) +
        close,
    ),
  );
}

function stableDecorativeThumbnailTokens(value) {
  return {
    ...value,
    requests: value.requests.map((request) => {
      if (request.role !== "image") return request;
      const url = new URL(request.url);
      if (!decorativeThumbnails.has(`${url.origin}${url.pathname}`) || !/^\?_=[a-f0-9]{32}$/u.test(url.search))
        return request;
      return { ...request, url: `${url.origin}${url.pathname}?_=reviewed-decorative-version` };
    }),
  };
}
