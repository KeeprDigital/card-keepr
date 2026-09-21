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
export function reviewedCosmeticComparison({ name, baseline, actual, observe }) {
  if (fusionProductCaptures.has(name)) {
    return {
      rule: "Fusion exact Product item permutation within the same publisher status section; every item byte retained.",
      expected: observe(sortedFusionProductItems(baseline.bytes), baseline.content_type),
      observed: observe(sortedFusionProductItems(actual.bytes), actual.content_type),
    };
  }
  if (name === "gundam-en-asia-errata-listing.json") {
    return {
      rule: "Gundam news items with the same publication date permute within the listing box, and three reviewed decorative collaboration thumbnails change their version token; every item byte, date order and Printing Image URL remain exact.",
      expected: stableDecorativeThumbnailTokens(
        observe(sortedSameDateGundamNewsItems(baseline.bytes), baseline.content_type),
      ),
      observed: stableDecorativeThumbnailTokens(
        observe(sortedSameDateGundamNewsItems(actual.bytes), actual.content_type),
      ),
    };
  }
  return null;
}

// Bandai orders same-day news items unstably between responses. Sort only runs
// of consecutive complete items that share one publication date; refuse any
// unknown or nested structure rather than discarding bytes.
function sortedSameDateGundamNewsItems(bytes) {
  const html = bytes.toString("utf8");
  const boxes = [...html.matchAll(/<div class="newsBox">/gu)];
  if (boxes.length !== 1) return bytes;
  const itemStart = /<div class="newsDetail [^"]*" data-tags="[^"]*">/gu;
  const items = [];
  const separators = [];
  let cursor = boxes[0].index + boxes[0][0].length;
  for (;;) {
    const rest = html.slice(cursor);
    const gap = rest.match(/^\s*/u)[0];
    if (rest.slice(gap.length).startsWith("</div>")) break;
    itemStart.lastIndex = 0;
    const start = itemStart.exec(rest);
    if (!start || start.index !== gap.length) return bytes;
    const end = completeElementEnd(rest, start.index + start[0].length);
    if (end === null) return bytes;
    const item = rest.slice(start.index, end);
    const dates = [...item.matchAll(/<dt class="cardDate">([^<]*)<\/dt>/gu)];
    if (dates.length !== 1) return bytes;
    separators.push(gap);
    items.push({ item, date: dates[0][1] });
    cursor += end;
  }
  if (items.length === 0) return bytes;
  const ordered = [];
  for (let index = 0; index < items.length;) {
    let next = index + 1;
    while (next < items.length && items[next].date === items[index].date) next += 1;
    ordered.push(...items.slice(index, next).sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0)));
    index = next;
  }
  const start = boxes[0].index + boxes[0][0].length;
  return Buffer.from(
    html.slice(0, start) + ordered.map(({ item }, index) => separators[index] + item).join("") + html.slice(cursor),
  );
}

// Index just past the `</div>` closing an element whose opening tag ends at `from`.
function completeElementEnd(html, from) {
  const tags = /<div\b|<\/div>/gu;
  tags.lastIndex = from;
  let depth = 1;
  for (let match = tags.exec(html); match; match = tags.exec(html)) {
    depth += match[0] === "</div>" ? -1 : 1;
    if (depth === 0) return match.index + match[0].length;
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
