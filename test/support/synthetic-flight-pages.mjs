// Synthetic Next.js flight pages for census tests (#330, #332). Only the page
// envelope and pagination are synthetic: callers pass unchanged source records
// taken from retained real captures. The decoder reads exactly the shape these
// helpers emit (`self.__next_f.push([1,"<id>:<json>\n..."])`).

function flightDocument(lines, markup = "") {
  const flight = `${lines.map((line, index) => `${(index + 1).toString(16)}:${JSON.stringify(line)}`).join("\n")}\n`;
  return `<!DOCTYPE html><html><body>${markup}<script>self.__next_f.push([1,${JSON.stringify(flight)}])</script></body></html>`;
}

/** A Piltover Archive gallery page: the `variants` grid, its pagination and the displayed total. */
export function syntheticPiltoverGalleryPage({ page, pages, total, variants }) {
  return flightDocument(
    [
      ["$", "div", null, { variants }],
      ["$", "nav", null, { currentPage: page, totalPages: pages, hasNext: page < pages, hasPrevious: page > 1 }],
    ],
    `<span>${total.toLocaleString("en-US")}</span><span>cards</span>`,
  );
}

/**
 * A HexDeck Images-format search page sorted by Set. Each row's `standard`
 * art variant is referenced by the markup exactly as the real render does.
 */
export function syntheticHexdeckSearchPage({ page, pageSize, totalCount, results }) {
  return flightDocument(
    [
      [
        "$",
        "section",
        null,
        {
          results,
          currentPage: page,
          pageSize,
          totalCount,
          displayFormat: "Images",
          sortField: "Set",
          sortDirection: "Ascending",
        },
      ],
    ],
    results.map((result) => `<img src="${result.imageUrl}standard" alt="">`).join(""),
  );
}
