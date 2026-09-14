import { operationalCallers } from "./http-callers.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";
import { parse } from "jsonc-parser";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import standaloneCode from "ajv/dist/standalone/index.js";
import { _ } from "ajv/dist/compile/codegen/index.js";

const bundled = await build({
  entryPoints: ["scripts/http-contract-registry.mjs"],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { workerFamilies, httpRouter } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
).catch((error) => {
  throw new Error(`HTTP registration could not load: ${error instanceof Error ? error.message : String(error)}`);
});
const check = process.argv.includes("--check");
function output(path, value) {
  if (check) {
    if (readFileSync(path, "utf8") !== value) throw new Error(`${path} is stale; run pnpm generate:http.`);
  } else writeFileSync(path, value);
}
const inventory = [];
const migrationFamilies = JSON.parse(readFileSync("contracts/http-migration-families.json", "utf8"));
const callers = operationalCallers();
const ajv = new Ajv2020({ strict: false, allErrors: true, code: { source: true, esm: true, formats: _`formats` } });
addFormats(ajv);
const validators = {};
const validatorKeys = {};
const schemaValidators = new Map();
for (const [worker, families] of Object.entries(workerFamilies)) {
  const routes = Object.values(families).flat();
  const implemented = new Set();
  for (const [family, entries] of Object.entries(families))
    for (const route of entries) {
      const path = route.pathname.replaceAll(/:([A-Za-z]+)/g, "{$1}");
      const key = `${route.method} ${path}`;
      if (implemented.has(key)) throw new Error(`Duplicate route: ${worker} ${key}`);
      implemented.add(key);
      const migration =
        worker === "admin"
          ? migrationFamilies.find((row) => row.method === route.method && row.path === route.pathname)
          : null;
      if (worker === "admin" && !migration)
        throw new Error(`Classify the new administration operation ${key} in http-migration-families.json.`);
      inventory.push({
        worker,
        family,
        method: route.method,
        path,
        contract: route.definition ? "generated" : "legacy",
        slice: migration?.slice ?? "Catalogue reads",
        named_cli: migration?.cli ?? (path === "/v1/cards" ? "cards search" : null),
        callers: callers(path.replaceAll(/\{[^}]+\}/g, "resource")),
      });
    }
  const config = parse(readFileSync(`apps/${worker === "read" ? "api" : "ingestion"}/wrangler.jsonc`, "utf8"));
  const servers = [
    ...new Set(
      [config.vars.PUBLIC_BASE_URL, ...Object.values(config.env ?? {}).map((env) => env.vars?.PUBLIC_BASE_URL)].filter(
        Boolean,
      ),
    ),
  ].map((url) => ({ url }));
  const doc = httpRouter(routes).getOpenAPI31Document({
    openapi: "3.1.0",
    info: {
      title: `Card Keepr ${worker === "read" ? "catalogue read" : "administration"} API`,
      version: "1.0.0",
      description:
        "Generated HTTP contracts. Unmigrated operations are explicitly inventoried; this document is not yet the complete Worker contract.",
    },
    servers,
  });
  const ids = new Set();
  for (const [path, operations] of Object.entries(doc.paths))
    for (const [method, operation] of Object.entries(operations)) {
      if (ids.has(operation.operationId)) throw new Error(`Duplicate operation ID: ${operation.operationId}`);
      ids.add(operation.operationId);
      if (!implemented.has(`${method.toUpperCase()} ${path}`)) throw new Error(`Unimplemented operation ${path}`);
      for (const [status, response] of Object.entries(operation.responses))
        for (const [media, representation] of Object.entries(response.content ?? {})) {
          if (!media.includes("json")) continue;
          const schema = { ...representation.schema, components: doc.components };
          const signature = JSON.stringify(schema);
          let name = schemaValidators.get(signature);
          if (!name) {
            name = `response${Object.keys(validators).length}`;
            ajv.addSchema(schema, name);
            validators[name] = name;
            schemaValidators.set(signature, name);
          }
          validatorKeys[`${worker} ${method} ${path} ${status} ${media}`] = name;
        }
    }
  for (const route of routes.filter((route) => route.definition)) {
    if (!doc.paths[route.definition.path]?.[route.definition.method])
      throw new Error(`Missing generated operation ${route.pathname}`);
  }
  function references(value) {
    if (!value || typeof value !== "object") return;
    if (value.$ref) {
      if (!value.$ref.startsWith("#/")) throw new Error(`Unbundled reference: ${value.$ref}`);
      const target = value.$ref
        .slice(2)
        .split("/")
        .reduce((node, key) => node?.[key.replaceAll("~1", "/").replaceAll("~0", "~")], doc);
      if (!target) throw new Error(`Unresolved reference: ${value.$ref}`);
    }
    for (const child of Object.values(value)) references(child);
  }
  references(doc);
  doc["x-unmigrated-operations"] = inventory
    .filter((row) => row.worker === worker && row.contract === "legacy")
    .map(({ method, path, family }) => ({ method, path, family }));
  output(`contracts/${worker}-openapi.json`, JSON.stringify(doc, null, 2) + "\n");
}
for (const worker of ["read", "admin"])
  for (const [method, path, treatment] of [
    ["GET", "/health", "authenticated-readiness"],
    ["GET", "/healthz", "unauthenticated-liveness"],
    ["HEAD", "/healthz", "unauthenticated-liveness"],
  ])
    inventory.push({ worker, method, path, contract: "platform", treatment, callers: callers(path) });
inventory.push({
  worker: "read",
  method: "OPTIONS",
  path: "/*",
  contract: "platform",
  treatment: "consumer-CORS-preflight",
});
inventory.push({
  worker: "admin",
  method: "POST",
  path: "/v1/dev-deployments",
  contract: "platform",
  treatment: "dev-only signed workflow identity",
  callers: callers("/v1/dev-deployments"),
});
for (const [path, treatment] of [
  ["/v1/staging-release-authorizations", "production-only signed manual workflow identity"],
  ["/v1/staging-deployments", "staging-only signed manual workflow identity"],
  ["/v1/staging-deployments/{release}/outcome", "staging-only signed manual workflow identity"],
])
  inventory.push({
    worker: "admin",
    method: "POST",
    path,
    contract: "platform",
    treatment,
    callers: callers(path.replaceAll(/\{[^}]+\}/g, "resource")),
  });
inventory.sort((a, b) => `${a.worker} ${a.path} ${a.method}`.localeCompare(`${b.worker} ${b.path} ${b.method}`, "en"));
output("contracts/http-route-inventory.json", JSON.stringify(inventory, null, 2) + "\n");
const code = standaloneCode(ajv, validators);
const compiled = await build({
  stdin: {
    contents: `import { fullFormats as formats } from "ajv-formats/dist/formats.js";\n${code}`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  format: "esm",
  platform: "neutral",
  write: false,
  minify: true,
});
output(
  "test/support/http-response-validators.mjs",
  `// Generated from HTTP registrations; run pnpm generate:http.\n${compiled.outputFiles[0].text}\nexport const responseValidators = ${JSON.stringify(validatorKeys)};\n`,
);
output(
  "test/support/http-response-validators.d.mts",
  Object.keys(validators)
    .map((name) => `export function ${name}(value: unknown): boolean;`)
    .join("\n") + "\nexport const responseValidators: Record<string, string>;\n",
);
