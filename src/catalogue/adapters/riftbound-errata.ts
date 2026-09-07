import { AdapterParseFailure } from "./adapter-parse-failure";
import { nodeTag, nodeText, riftboundArticle } from "./riftbound-article";

export const riftboundOriginsErrataUrl =
  "https://playriftbound.com/en-us/news/rules-and-releases/riftbound-origins-card-errata/";

export function riftboundOriginsErrata(bytes: Uint8Array, url: string) {
  if (url !== riftboundOriginsErrataUrl) throw new AdapterParseFailure("Unregistered Riftbound Errata article.");
  const article = riftboundArticle(bytes);
  if (article.title !== "Riftbound: Origins Card Errata")
    throw new AdapterParseFailure("Riftbound Errata article title changed.");
  const entries: { heading: string; old: string[]; corrected: string[]; wording: string[] }[] = [];
  let current: (typeof entries)[number] | null = null;
  let section: "old" | "corrected" | null = null;
  for (const node of article.nodes) {
    const tag = nodeTag(node);
    const text = nodeText(node).trim();
    if (tag === "h2") {
      current = { heading: text, old: [], corrected: [], wording: [] };
      entries.push(current);
      section = null;
    } else if (current) {
      if (text) current.wording.push(text);
      if (tag === "h5") {
        if (text === "[NEW TEXT]" && section === null) section = "corrected";
        else if (text === "[OLD TEXT]" && section === "corrected") section = "old";
        else throw new AdapterParseFailure("Riftbound Erratum old/new sections changed.");
      } else if (tag === "p" && text && !text.startsWith("Note:")) {
        if (!section) throw new AdapterParseFailure("Riftbound Erratum text has no old/new label.");
        current[section].push(text);
      }
    }
  }
  if (
    entries.length !== 31 ||
    new Set(entries.map((e) => e.heading)).size !== entries.length ||
    entries.some((e) => !e.heading || !e.old.length || !e.corrected.length)
  )
    throw new AdapterParseFailure("Riftbound Origins Errata coverage changed or is incomplete.");
  return entries.map((entry) => ({
    kind: "official_erratum" as const,
    game: "riftbound" as const,
    target: { type: "card" as const, official_identity: { kind: "publisher_name" as const, value: entry.heading } },
    published_on: article.publishedOn,
    effective_from: null,
    observed_printed_rules_text: entry.old.join("\n"),
    corrected_rules_text: entry.corrected.join("\n"),
    official_wording: entry.wording.join("\n"),
    applies_to_parallel_printings: true,
    source: { kind: "article_heading" as const, url, heading: entry.heading },
    completeness: {
      structurally_complete: true,
      required_surfaces_complete: true,
      partitions_complete: true,
      declared_record_count: 1,
      parsed_record_count: 1,
    },
  }));
}
