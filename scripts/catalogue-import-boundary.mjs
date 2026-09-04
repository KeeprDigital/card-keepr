#!/usr/bin/env node
// Enforces the catalogue cluster contract (issue #98, src/catalogue/README.md).
//
// Walks static `import` / `export ... from` statements in the worker
// entrypoints (apps/*/src), src/http, and every module under src/catalogue,
// resolves the relative ones, and checks each edge against these rules:
//
//   api-worker-surface   apps/api/src/** imports, out of src/, only the
//                        `read` and `shared` cluster indexes, src/http/**,
//                        and src/runtime-capabilities.mjs (plus its own
//                        files). The api worker never reaches an
//                        administration cluster or a cluster internal.
//   worker-cluster-index a worker entrypoint imports a catalogue cluster
//                        only through the cluster's index.ts.
//   cluster-direction    a module under src/catalogue/<cluster>/ imports
//                        only the clusters listed for it in `allowedImports`
//                        (the README's "may import from" table). In
//                        particular no `read` module imports `ingestion`,
//                        `reconciliation`, `curated`, or `source-evidence`,
//                        and `shared` imports no other cluster.
//   cluster-index        a cross-cluster import targets the cluster's
//                        index.ts, never a module inside it.
//   http-leaf            src/http/** imports nothing under src/catalogue,
//                        so the api worker cannot reach a cluster through it.
//   unresolved           a relative import must resolve to a file.
//
// Type-only imports count: a type-level edge still couples the modules.
// Tests, scripts, the CLI, and acceptance may import cluster internals by
// path; they are not scanned.
//
// Usage: node scripts/catalogue-import-boundary.mjs
// Exit code is 1 when at least one violation is found. Each violation names
// the importing file, the import specifier, and the rule it breaks.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalogueDir = join(root, "src", "catalogue");
const httpDir = join(root, "src", "http");
const apiDir = join(root, "apps", "api", "src");
const ingestionDir = join(root, "apps", "ingestion", "src");

// The dependency direction from src/catalogue/README.md, read as
// "may import from". `ingestion` may import every cluster.
const allowedImports = {
  shared: [],
  adapters: ["shared"],
  legality: ["shared", "adapters"],
  read: ["shared", "legality", "adapters"],
  curated: ["shared", "legality"],
  "source-evidence": ["shared", "adapters", "curated"],
  reconciliation: ["shared", "adapters", "legality", "curated", "source-evidence"],
  export: ["shared", "legality", "reconciliation"],
  "backup-recovery": ["shared", "read", "legality"],
  ingestion: [
    "shared",
    "adapters",
    "legality",
    "read",
    "curated",
    "source-evidence",
    "reconciliation",
    "export",
    "backup-recovery",
  ],
};

const apiClusterSurface = new Set(["read", "shared"]);
const apiSharedModules = new Set([join(root, "src", "runtime-capabilities.mjs")]);

function isModuleFile(name) {
  return /\.(ts|mts|mjs)$/.test(name) && !name.endsWith(".d.ts") && !name.endsWith(".d.mts");
}

function moduleFilesUnder(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...moduleFilesUnder(path));
    else if (entry.isFile() && isModuleFile(entry.name)) files.push(path);
  }
  return files;
}

function isFile(path) {
  return existsSync(path) && statSync(path).isFile();
}

function resolveImport(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, `${base}.mts`, join(base, "index.ts")];
  return candidates.find(isFile) ?? null;
}

function isUnder(path, directory) {
  return path === directory || path.startsWith(directory + sep);
}

function clusterOf(path) {
  if (!isUnder(path, catalogueDir)) return null;
  const segments = relative(catalogueDir, path).split(sep);
  return segments.length > 1 ? segments[0] : null;
}

function isClusterIndex(path) {
  const cluster = clusterOf(path);
  return cluster !== null && path === join(catalogueDir, cluster, "index.ts");
}

function locate(path) {
  if (isUnder(path, apiDir)) return { kind: "api" };
  if (isUnder(path, ingestionDir)) return { kind: "ingestion-worker" };
  if (isUnder(path, httpDir)) return { kind: "http" };
  const cluster = clusterOf(path);
  if (cluster !== null) return { kind: "cluster", cluster };
  return { kind: "other" };
}

const importPattern = /^\s*(import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?["'](\.\.?\/[^"']+)["']/gm;

const scannedFiles = [
  ...moduleFilesUnder(apiDir),
  ...moduleFilesUnder(ingestionDir),
  ...moduleFilesUnder(httpDir),
  ...moduleFilesUnder(catalogueDir),
].sort();

const violations = [];
let edges = 0;

function report(file, specifier, rule, detail) {
  violations.push(`${relative(root, file)}: import "${specifier}" violates ${rule}: ${detail}`);
}

for (const file of scannedFiles) {
  const source = readFileSync(file, "utf8");
  const importer = locate(file);
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[3];
    edges += 1;
    const target = resolveImport(file, specifier);
    if (target === null) {
      report(file, specifier, "unresolved", "the relative import does not resolve to a file");
      continue;
    }
    const imported = locate(target);
    const targetCluster = imported.kind === "cluster" ? imported.cluster : null;
    switch (importer.kind) {
      case "api": {
        if (imported.kind === "api" || imported.kind === "http" || apiSharedModules.has(target)) break;
        if (targetCluster !== null && apiClusterSurface.has(targetCluster) && isClusterIndex(target)) break;
        report(
          file,
          specifier,
          "api-worker-surface",
          "the api worker imports only the read and shared cluster indexes, src/http, and src/runtime-capabilities.mjs",
        );
        break;
      }
      case "ingestion-worker": {
        if (targetCluster !== null && !isClusterIndex(target)) {
          report(
            file,
            specifier,
            "worker-cluster-index",
            `a worker entrypoint imports the ${targetCluster} cluster only through its index.ts`,
          );
        }
        break;
      }
      case "http": {
        if (targetCluster !== null) {
          report(file, specifier, "http-leaf", "src/http imports nothing under src/catalogue");
        }
        break;
      }
      case "cluster": {
        if (targetCluster === null || targetCluster === importer.cluster) break;
        const allowed = allowedImports[importer.cluster];
        if (allowed === undefined) {
          report(file, specifier, "cluster-direction", `${importer.cluster} is not a cluster listed in the README`);
          break;
        }
        if (!allowed.includes(targetCluster)) {
          report(
            file,
            specifier,
            "cluster-direction",
            `${importer.cluster} may import only ${allowed.length === 0 ? "no other cluster" : allowed.join(", ")}`,
          );
        }
        if (!isClusterIndex(target)) {
          report(
            file,
            specifier,
            "cluster-index",
            `a cross-cluster import targets ${targetCluster}/index.ts, not a module inside the cluster`,
          );
        }
        break;
      }
      default:
        break;
    }
  }
}

console.log(`Checked ${edges} relative imports across ${scannedFiles.length} modules.`);
if (violations.length === 0) {
  console.log("No catalogue boundary violation.");
  process.exit(0);
}
for (const violation of violations.sort()) console.log(violation);
console.log(`\n${violations.length} catalogue boundary violation${violations.length === 1 ? "" : "s"}.`);
process.exit(1);
