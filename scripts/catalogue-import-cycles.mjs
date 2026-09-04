#!/usr/bin/env node
// Reports import cycles among the modules in src/catalogue.
//
// Walks static `import` / `export ... from` statements across src/catalogue/*.ts,
// builds a module graph over relative imports that resolve within the directory,
// and prints every strongly connected component larger than one module
// (Tarjan's algorithm). Type-only imports (`import type`) count by default,
// because a type-level cycle still couples the modules; pass --runtime-only
// to ignore them and report only cycles that survive compilation.
//
// Usage: node scripts/catalogue-import-cycles.mjs [--runtime-only]
// Exit code is 1 when at least one cycle is found.

import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const includeTypeImports = !process.argv.includes("--runtime-only");
const catalogueDir = resolve(dirname(fileURLToPath(import.meta.url)), "../src/catalogue");

const moduleFiles = readdirSync(catalogueDir)
  .filter((name) => /\.(ts|mts|mjs)$/.test(name) && !name.endsWith(".d.ts") && !name.endsWith(".d.mts"))
  .sort();

const moduleNames = new Set(moduleFiles.map(moduleName));

function moduleName(fileName) {
  return basename(fileName).replace(/\.(ts|mts|mjs)$/, "");
}

const importPattern =
  /^\s*(import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?["'](\.\/[^"']+)["']/gm;

const graph = new Map();
for (const fileName of moduleFiles) {
  const source = readFileSync(join(catalogueDir, fileName), "utf8");
  const edges = new Set();
  for (const match of source.matchAll(importPattern)) {
    const [, , typeOnly, specifier] = match;
    if (typeOnly && !includeTypeImports) continue;
    const target = moduleName(specifier.slice(2).replace(/\.js$/, ""));
    if (moduleNames.has(target) && target !== moduleName(fileName)) edges.add(target);
  }
  graph.set(moduleName(fileName), [...edges].sort());
}

// Tarjan's strongly connected components.
let index = 0;
const indices = new Map();
const lowLinks = new Map();
const onStack = new Set();
const stack = [];
const components = [];

function strongConnect(node) {
  indices.set(node, index);
  lowLinks.set(node, index);
  index += 1;
  stack.push(node);
  onStack.add(node);
  for (const next of graph.get(node) ?? []) {
    if (!indices.has(next)) {
      strongConnect(next);
      lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(next)));
    } else if (onStack.has(next)) {
      lowLinks.set(node, Math.min(lowLinks.get(node), indices.get(next)));
    }
  }
  if (lowLinks.get(node) === indices.get(node)) {
    const component = [];
    let member;
    do {
      member = stack.pop();
      onStack.delete(member);
      component.push(member);
    } while (member !== node);
    components.push(component.sort());
  }
}

for (const node of [...graph.keys()].sort()) {
  if (!indices.has(node)) strongConnect(node);
}

const cycles = components.filter((component) => component.length > 1);

console.log(
  `Scanned ${moduleFiles.length} modules in src/catalogue (${includeTypeImports ? "including" : "ignoring"} type-only imports).`,
);
if (cycles.length === 0) {
  console.log("No strongly connected component larger than one module.");
  process.exit(0);
}

for (const component of cycles) {
  const members = new Set(component);
  console.log(`\nCycle of ${component.length} modules:`);
  for (const member of component) {
    const internalEdges = (graph.get(member) ?? []).filter((target) => members.has(target));
    console.log(`  ${member} -> ${internalEdges.join(", ")}`);
  }
}
process.exit(1);
