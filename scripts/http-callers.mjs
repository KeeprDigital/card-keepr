import { readdirSync, readFileSync } from "node:fs";
import ts from "typescript";

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() &&
    !["real-sources", "retained-official-source", ".wrangler", "node_modules"].includes(entry.name)
      ? files(`${directory}/${entry.name}`)
      : entry.isFile() && /\.(?:mjs|ts)$/.test(entry.name)
        ? [`${directory}/${entry.name}`]
        : [],
  );
}
/** Potential callers are identified from parsed URL literals, including template holes.
 * This is an inventory for migration review, not proof that a test executes a route. */
export function operationalCallers() {
  const references = [];
  for (const file of ["cli", "scripts", "acceptance", "apps/api/test", "apps/ingestion/test", "test/support"].flatMap(
    files,
  )) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    function visit(node) {
      let value;
      if (ts.isStringLiteralLike(node)) value = node.text;
      else if (ts.isTemplateExpression(node))
        value = node.head.text + node.templateSpans.map((span) => `*${span.literal.text}`).join("");
      if (value && /\/(?:v1\/|admin\/v1\/|health|docs|openapi\.json)/.test(value)) {
        const start = value.search(/\/(?:v1\/|admin\/v1\/|health|docs|openapi\.json)/);
        const path = value
          .slice(start)
          .split("?")[0]
          .replaceAll(/\{[^}]+\}/g, "*")
          .replaceAll(/:[A-Za-z][\w-]*/g, "*");
        const pattern = path
          .split("*")
          .map((part) => part.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("[^/?]+");
        references.push({ file, path, pattern: new RegExp(`^${pattern}$`) });
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return (path) => [...new Set(references.filter((ref) => ref.pattern.test(path)).map((ref) => ref.file))].sort();
}
