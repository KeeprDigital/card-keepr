import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { expect } from "vitest";

/** Parse the complete delivered page, including every operation and local schema link. */
export function assertDocumentationPage(
  html: string,
  document: { paths: Record<string, Record<string, { operationId: string }>>; components?: { schemas?: object } },
  specificationUrl: string,
) {
  const elements: DefaultTreeAdapterTypes.Element[] = [];
  function visit(node: DefaultTreeAdapterTypes.Node) {
    if ("tagName" in node) elements.push(node);
    if ("childNodes" in node) node.childNodes.forEach(visit);
  }
  visit(parse(html));
  const attributes = (element: DefaultTreeAdapterTypes.Element) =>
    Object.fromEntries(element.attrs.map(({ name, value }) => [name, value]));
  const ids = elements.map((element) => attributes(element).id).filter(Boolean);
  expect(new Set(ids).size).toBe(ids.length);
  for (const operations of Object.values(document.paths))
    for (const operation of Object.values(operations)) expect(ids).toContain(operation.operationId);
  for (const name of Object.keys(document.components?.schemas ?? {})) expect(ids).toContain(`schema-${name}`);
  const links = elements.filter((element) => element.tagName === "a").map((element) => attributes(element).href);
  expect(links).toContain(specificationUrl);
  for (const link of links) {
    if (link?.startsWith("#")) expect(ids, link).toContain(decodeURIComponent(link.slice(1)));
    else expect(link).toBe(specificationUrl);
  }
  // A browser can render this protected page with networking disabled.
  expect(elements.filter((element) => ["script", "link", "iframe", "form"].includes(element.tagName))).toEqual([]);
  expect(elements.filter((element) => "src" in attributes(element))).toEqual([]);
}
