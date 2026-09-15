import { operationalCallers } from "./http-callers.mjs";
import { environmentNames } from "../src/http/environment-target.mjs";
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
const expectedOperations = JSON.parse(readFileSync("contracts/http-operations.json", "utf8"));
const expectedKeys = new Set();
for (const row of expectedOperations) {
  const key = `${row.worker} ${row.method} ${row.path.replaceAll(/:([A-Za-z]+)/g, "{$1}")}`;
  if (!workerFamilies[row.worker] || expectedKeys.has(key)) throw new Error(`Invalid required operation: ${key}`);
  expectedKeys.add(key);
}
const callers = operationalCallers();
const ajv = new Ajv2020({
  strict: false,
  allErrors: true,
  inlineRefs: false,
  code: { source: true, esm: true, formats: _`formats` },
});
addFormats(ajv);
const validators = {};
const validatorKeys = {};
const headerValidatorKeys = {};
const schemaValidators = new Map();
function schemaValidator(root, schema, path) {
  const signature = JSON.stringify({ root, schema });
  let name = schemaValidators.get(signature);
  if (!name) {
    name = `response${Object.keys(validators).length}`;
    const pointer = path.map((part) => part.replaceAll("~", "~0").replaceAll("/", "~1")).join("/");
    ajv.addSchema({ $ref: `${root}#/${pointer}` }, name);
    validators[name] = name;
    schemaValidators.set(signature, name);
  }
  return name;
}
for (const [worker, families] of Object.entries(workerFamilies)) {
  const routes = Object.values(families).flat();
  const implemented = new Set();
  for (const [family, entries] of Object.entries(families))
    for (const route of entries) {
      const path = route.pathname.replaceAll(/:([A-Za-z]+)/g, "{$1}");
      const key = `${route.method} ${path}`;
      if (implemented.has(key)) throw new Error(`Duplicate route: ${worker} ${key}`);
      implemented.add(key);
      const expected = expectedOperations.find(
        (row) =>
          row.worker === worker && row.method === route.method && row.path.replaceAll(/:([A-Za-z]+)/g, "{$1}") === path,
      );
      if (!expected) throw new Error(`Classify the new operation ${worker} ${key} in http-operations.json.`);
      if (expected.family !== family) throw new Error(`Operation ownership changed: ${worker} ${key}`);
      inventory.push({
        worker,
        family,
        method: route.method,
        path,
        contract: "generated",
        slice: expected.slice,
        ...(["readiness", "liveness", "preflight", "documentation", "platform"].includes(family)
          ? {
              treatment: {
                readiness: "authenticated-readiness",
                liveness: "unauthenticated-liveness",
                preflight: "consumer-CORS-preflight",
                documentation: worker === "read" ? "public-documentation" : "owner-documentation",
                platform: "signed-workflow-deployment",
              }[family],
            }
          : {}),
        named_cli: expected.cli,
        callers: callers(path.replaceAll(/\{[^}]+\}/g, "resource")),
      });
    }
  for (const expected of expectedOperations.filter((row) => row.worker === worker)) {
    const key = `${expected.method} ${expected.path.replaceAll(/:([A-Za-z]+)/g, "{$1}")}`;
    if (!implemented.has(key)) throw new Error(`Required operation disappeared: ${worker} ${key}`);
  }
  const config = parse(readFileSync(`apps/${worker === "read" ? "api" : "ingestion"}/wrangler.jsonc`, "utf8"));
  const servers = [
    ...new Set(
      [
        config.vars.PUBLIC_BASE_URL,
        ...["dev", "staging"].map(
          (environment) => environmentNames(environment).publicBases[worker === "read" ? "api" : "ingestion"],
        ),
        ...Object.values(config.env ?? {}).map((env) => env.vars?.PUBLIC_BASE_URL),
      ].filter(Boolean),
    ),
  ].map((url) => ({ url }));
  const doc = httpRouter(routes).getOpenAPI31Document({
    openapi: "3.1.0",
    info: {
      title: `Card Keepr ${worker === "read" ? "catalogue read" : "administration"} API`,
      version: "1.0.0",
      description:
        worker === "read"
          ? "Complete catalogue reference. Catalogue data and readiness require the consumer bearer key. Documentation and liveness are publicly readable; consumer requests retain their allowed-origin policy."
          : "Complete administration reference. Owner operations and documentation require the administration bearer key; deployment operations require their separately documented signed Workflow credentials. Readiness and documentation remain available during recovery.",
    },
    servers,
  });
  // One root per Worker lets all response validators share compiled components.
  // Separate roots for every response duplicate large retained-record schemas.
  const schemaRoot = `urn:card-keepr:http:${worker}`;
  for (const entries of Object.values(doc.components ?? {}))
    for (const name of Object.keys(entries ?? {}))
      if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`Invalid OpenAPI component name: ${name}`);
  ajv.addSchema(doc, schemaRoot);
  const ids = new Set();
  for (const [path, operations] of Object.entries(doc.paths))
    for (const [method, operation] of Object.entries(operations)) {
      if (ids.has(operation.operationId)) throw new Error(`Duplicate operation ID: ${operation.operationId}`);
      ids.add(operation.operationId);
      if (!implemented.has(`${method.toUpperCase()} ${path}`)) throw new Error(`Unimplemented operation ${path}`);
      for (const [status, response] of Object.entries(operation.responses)) {
        for (const [header, declaration] of Object.entries(response.headers ?? {})) {
          if (!declaration.schema)
            throw new Error(`Missing header schema: ${worker} ${method} ${path} ${status} ${header}`);
          headerValidatorKeys[`${worker} ${method} ${path} ${status} ${header}`] = schemaValidator(
            schemaRoot,
            declaration.schema,
            ["paths", path, method, "responses", status, "headers", header, "schema"],
          );
        }
        for (const [media, representation] of Object.entries(response.content ?? {})) {
          if (!media.includes("json")) continue;
          validatorKeys[`${worker} ${method} ${path} ${status} ${media}`] = schemaValidator(
            schemaRoot,
            representation.schema,
            ["paths", path, method, "responses", status, "content", media, "schema"],
          );
        }
      }
    }
  for (const route of routes) {
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
  output(`contracts/${worker}-openapi.json`, JSON.stringify(doc, null, 2) + "\n");
}
inventory.sort((a, b) => `${a.worker} ${a.path} ${a.method}`.localeCompare(`${b.worker} ${b.path} ${b.method}`, "en"));
output("contracts/http-route-inventory.json", JSON.stringify(inventory, null, 2) + "\n");
// Vite transports each module with its source map to the test Worker. Keep the
// separate schema roots in separate modules so their combined validation code
// does not exceed the Worker's per-message limit during test startup.
const validatorModules = [];
for (const worker of Object.keys(workerFamilies)) {
  const names = new Set(
    [...Object.entries(validatorKeys), ...Object.entries(headerValidatorKeys)]
      .filter(([key]) => key.startsWith(`${worker} `))
      .map(([, name]) => name),
  );
  const code = standaloneCode(ajv, Object.fromEntries([...names].map((name) => [name, name])));
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
  const filename = `http-response-validators.${worker}.mjs`;
  output(
    `test/support/${filename}`,
    `// Generated from HTTP registrations; run pnpm generate:http.\n${compiled.outputFiles[0].text}`,
  );
  validatorModules.push(`export * from "./${filename}";`);
}
output(
  "test/support/http-response-validators.mjs",
  `// Generated from HTTP registrations; run pnpm generate:http.\n${validatorModules.join("\n")}\nexport const responseValidators = ${JSON.stringify(validatorKeys)};\nexport const headerValidators = ${JSON.stringify(headerValidatorKeys)};\n`,
);
output(
  "test/support/http-response-validators.d.mts",
  Object.keys(validators)
    .map((name) => `export function ${name}(value: unknown): boolean;`)
    .join("\n") +
    "\nexport const responseValidators: Record<string, string>;\nexport const headerValidators: Record<string, string>;\n",
);
