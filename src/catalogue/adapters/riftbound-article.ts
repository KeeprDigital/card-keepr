import { parse, parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { AdapterParseFailure } from "./adapter-parse-failure";

type Node = DefaultTreeAdapterMap["node"];
export function riftboundArticle(bytes: Uint8Array) {
  const document = parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  const scripts: Node[] = [];
  const visit = (node: Node) => {
    if (
      "tagName" in node &&
      node.tagName === "script" &&
      node.attrs.some((a) => a.name === "id" && a.value === "__NEXT_DATA__")
    )
      scripts.push(node);
    if ("childNodes" in node) node.childNodes.forEach(visit);
  };
  visit(document);
  if (scripts.length !== 1) throw new AdapterParseFailure("Riftbound article needs one publisher document.");
  const data = JSON.parse(nodeText(scripts[0]!));
  const blades: Record<string, unknown>[] = data?.props?.pageProps?.page?.blades;
  if (!Array.isArray(blades)) throw new AdapterParseFailure("Riftbound article blades are missing.");
  const mastheads = blades.filter((b) => b.type === "articleMasthead");
  const bodies = blades.filter((b) => b.type === "articleRichText");
  if (mastheads.length !== 1 || bodies.length !== 1)
    throw new AdapterParseFailure("Riftbound article structure changed.");
  const rich = bodies[0]!.richText as { type?: unknown; body?: unknown };
  const published = mastheads[0]!.publishDate;
  if (
    rich?.type !== "html" ||
    typeof rich.body !== "string" ||
    typeof published !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T/.test(published)
  )
    throw new AdapterParseFailure("Riftbound article body or publication date is missing.");
  return {
    title: mastheads[0]!.title,
    publishedOn: published.slice(0, 10),
    nodes: parseFragment(rich.body).childNodes,
  };
}
export function nodeText(node: Node): string {
  if (node.nodeName === "#text") return (node as DefaultTreeAdapterMap["textNode"]).value;
  if ("tagName" in node && node.tagName === "br") return "\n";
  const text = "childNodes" in node ? node.childNodes.map(nodeText).join("") : "";
  return text + ("tagName" in node && ["li", "p", "h2", "h3"].includes(node.tagName) ? "\n" : "");
}
export function nodeTag(node: Node): string | null {
  return "tagName" in node ? node.tagName : null;
}
