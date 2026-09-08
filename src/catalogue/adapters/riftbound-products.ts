import { AdapterParseFailure } from "./adapter-parse-failure";
import { nodeTag, nodeText, riftboundArticle } from "./riftbound-article";

export const riftboundProductsUrl = "https://playriftbound.com/en-us/news/announcements/products-and-sets-into-2027/";
const headings = [
  "Secret Garden",
  "Riftbound x T1 2025 Worlds Champion Collection",
  "Gift of the Rift Bundle",
  "Set 5: Radiance",
  "Set 6: Legacy",
  "Proving Grounds, 2nd Edition",
  "Set 7: The Reckoning",
  "Set 8",
  "Set 9",
];

export function riftboundAnnouncedProducts(bytes: Uint8Array, url: string) {
  if (url !== riftboundProductsUrl) throw new AdapterParseFailure("Unregistered Riftbound Product article.");
  const article = riftboundArticle(bytes);
  const sections: { heading: string; body: string[] }[] = [];
  let current: (typeof sections)[number] | null = null;
  for (const node of article.nodes) {
    const tag = nodeTag(node);
    const text = nodeText(node).trim();
    if (tag === "h2" || (tag === "h3" && text === "Proving Grounds, 2nd Edition")) {
      if (text === "Looking at Riftbound’s 2027 Releases") continue;
      current = { heading: text, body: [] };
      sections.push(current);
    } else if (current && text) current.body.push(text);
  }
  if (sections.map((s) => s.heading).join("|") !== headings.join("|"))
    throw new AdapterParseFailure("Riftbound Product announcement coverage changed.");
  return sections.map((section) => {
    const body = section.body.join("\n");
    const name = section.heading.replace(/^Set [567]: /, "");
    const code = body.match(/3-Letter Code\s*:\s*([A-Z0-9]{3})\b/)?.[1] ?? null;
    const day =
      body.match(/\bRelease\s*:\s*([A-Za-z]+) (\d{1,2}), (\d{4})/) ??
      body.match(/\breleasing ([A-Za-z]+) (\d{1,2}), (\d{4})/);
    const quarter = body.match(/\bArriving Q([1-4]) (\d{4})/);
    const date = day
      ? { precision: "day", value: dayValue(day) }
      : quarter
        ? { precision: "quarter", value: `${quarter[2]}-Q${quarter[1]}` }
        : { precision: "unknown", value: null };
    return {
      completeness: {
        structurally_complete: true,
        required_surfaces_complete: true,
        partitions_complete: true,
        declared_record_count: sections.length,
        parsed_record_count: sections.length,
      },
      product_release_catalogue: {
        products: [
          {
            reference: { kind: code === null ? "name" : "official_code", value: code ?? name },
            official_code: code,
            name,
            releases: [
              {
                event_key: "announced-english-release",
                region: "unknown",
                date,
                status: date.value === null ? null : "announced",
              },
            ],
          },
        ],
        distribution_contexts: [],
        relationships: [],
      },
      source_sidecar: {
        article_url: url,
        published_on: article.publishedOn,
        heading: section.heading,
        announcement_text: body,
        unmapped_optional_fields: [],
      },
    };
  });
}
function dayValue(match: RegExpMatchArray) {
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
  const month = months.indexOf(match[1]!);
  if (month < 0) throw new AdapterParseFailure("Riftbound published release month changed.");
  return `${match[3]}-${String(month + 1).padStart(2, "0")}-${match[2]!.padStart(2, "0")}`;
}
