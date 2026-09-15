import { createRoute, z } from "@hono/zod-openapi";
import { problemResponses, secured, streamingHttpRoute } from "./openapi";
import { publicUrl, type PublicBase } from "./public-base";

type DocumentationContext = { request: Request; requestId: string; base: PublicBase };
export type ApiDocument = {
  info: { title: string; description?: string };
  paths: Record<string, unknown>;
  components?: { schemas?: Record<string, unknown>; securitySchemes?: Record<string, unknown> };
};

const documentSchema = z.object({
  openapi: z.literal("3.1.0"),
  info: z.object({ title: z.string(), version: z.string() }),
  servers: z.array(z.object({ url: z.url() })),
  paths: z.record(z.string(), z.unknown()),
  components: z.record(z.string(), z.unknown()),
});
const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
};

/** The same generated document supplies the JSON download and the complete HTML
 * reference. Protected pages need no subsequent asset fetch or browser credential storage. */
export function documentationRoutes(document: ApiDocument, access: "public" | "owner") {
  const prefix = access === "public" ? "catalogue" : "administration";
  const cache = access === "public" ? "public, max-age=300" : "private, no-store";
  const headers = { "Cache-Control": cache, ...securityHeaders };
  const declaredHeaders = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      { required: true, schema: { type: "string" as const, const: value } },
    ]),
  );
  const route = streamingHttpRoute<DocumentationContext>();
  const responses = access === "owner" ? problemResponses : {};
  return [
    route(
      createRoute({
        method: "get",
        path: "/openapi.json",
        operationId: `${prefix}OpenApi`,
        security: access === "public" ? [] : secured,
        summary: "Download the complete OpenAPI specification",
        responses: {
          ...responses,
          200: {
            description: "Bundled OpenAPI for this deployment.",
            headers: declaredHeaders,
            content: { "application/json": { schema: documentSchema } },
          },
        },
      }),
      async (c) => Response.json(deployedDocument(document, c.env.base), { headers }),
    ),
    route(
      createRoute({
        method: "get",
        path: "/docs",
        operationId: `${prefix}Documentation`,
        security: access === "public" ? [] : secured,
        summary: "Read the API reference",
        responses: {
          ...responses,
          200: {
            description: "Complete, self-contained API reference; no scripts or external assets.",
            headers: declaredHeaders,
            content: { "text/html": { schema: z.string() } },
          },
        },
      }),
      async (c) =>
        new Response(renderDocumentation(deployedDocument(document, c.env.base), c.env.base, access), {
          headers: { ...headers, "Content-Type": "text/html; charset=utf-8" },
        }),
    ),
  ];
}

function deployedDocument(document: ApiDocument, base: PublicBase) {
  return { ...document, servers: [{ url: `${base.origin}${base.basePath}` }] };
}

function escape(value: unknown): string {
  return String(value ?? "").replaceAll(
    /[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function schemaMarkup(value: unknown): string {
  const json = JSON.stringify(value, null, 2) ?? "";
  // Split before escaping so every JSON-pointer character remains one complete
  // link. Component names can contain e.g. '$', '~' or escaped '/'.
  const markup = json
    .split(/("#\/components\/schemas\/[^"\n]+")/g)
    .map((part) => {
      if (!part.startsWith('"#/components/schemas/')) return escape(part);
      const reference = JSON.parse(part) as string;
      const name = reference.slice("#/components/schemas/".length).replaceAll("~1", "/").replaceAll("~0", "~");
      return `<a href="#${escape(encodeURIComponent(`schema-${name}`))}">${escape(part)}</a>`;
    })
    .join("");
  return `<pre><code>${markup}</code></pre>`;
}

function contentMarkup(value: unknown): string {
  return Object.entries(object(value))
    .map(([media, representation]) => `<h4>${escape(media)}</h4>${schemaMarkup(object(representation).schema)}`)
    .join("");
}

function operationMarkup(path: string, method: string, value: unknown): string {
  const operation = object(value);
  const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];
  const security = Array.isArray(operation.security) ? operation.security : [];
  const credentials =
    security.length === 0
      ? "No credentials required."
      : security.map((requirement) => Object.keys(object(requirement)).join(" + ")).join(" or ");
  return `<article id="${escape(operation.operationId)}"><h2><span class="method">${escape(method.toUpperCase())}</span> <code>${escape(path)}</code></h2>
    ${operation.summary ? `<h3>${escape(operation.summary)}</h3>` : ""}<p>${escape(operation.description)}</p>
    <p><strong>Authentication:</strong> ${escape(credentials)}</p>
    ${
      parameters.length
        ? `<h3>Parameters</h3><table><thead><tr><th>Name</th><th>Location</th><th>Required</th><th>Value</th></tr></thead><tbody>${parameters
            .map((entry) => {
              const parameter = object(entry);
              return `<tr><td><code>${escape(parameter.name)}</code></td><td>${escape(parameter.in)}</td><td>${parameter.required ? "Yes" : "No"}</td><td>${escape(parameter.description)}${schemaMarkup(parameter.schema)}</td></tr>`;
            })
            .join("")}</tbody></table>`
        : ""
    }
    ${operation.requestBody ? `<h3>Request body${object(operation.requestBody).required ? " (required)" : ""}</h3>${contentMarkup(object(operation.requestBody).content)}` : ""}
    <h3>Responses</h3>${Object.entries(object(operation.responses))
      .map(([status, value]) => {
        const response = object(value);
        return `<details><summary><strong>${escape(status)}</strong> ${escape(response.description)}</summary>${Object.keys(object(response.headers)).length ? `<h4>Headers</h4>${schemaMarkup(response.headers)}` : ""}${response.content ? contentMarkup(response.content) : "<p>No response body.</p>"}</details>`;
      })
      .join("")}</article>`;
}

export function renderDocumentation(document: ApiDocument, base: PublicBase, access: "public" | "owner"): string {
  const operations = Object.entries(document.paths).flatMap(([path, entries]) =>
    Object.entries(object(entries))
      .filter(([method]) => ["get", "head", "post", "put", "patch", "delete", "options"].includes(method))
      .map(([method, operation]) => ({ path, method, operation })),
  );
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(document.info.title)}</title>
  <style>body{margin:0;background:#f5f4ef;color:#202a29;font:16px/1.55 system-ui,sans-serif}header,main{max-width:1120px;margin:auto;padding:32px}header{padding-top:56px}h1{font-size:2.4rem;letter-spacing:-.04em}h2{font-size:1.25rem;overflow-wrap:anywhere}h3{margin-bottom:8px}a{color:#00675e}code{font-size:.88em}pre{padding:16px;background:#f1f3f1;overflow:auto;max-height:36rem;white-space:pre-wrap;overflow-wrap:anywhere}article{background:white;padding:28px;margin:24px 0;border:1px solid #d7dcd8;border-radius:8px;scroll-margin-top:20px}.method{font-size:.8rem;color:#00675e}details{border-top:1px solid #e3e6e2;padding:12px 0}summary{cursor:pointer}nav ul{columns:2;list-style:none;padding:0}nav li{padding:5px 0;break-inside:avoid;overflow-wrap:anywhere}table{border-collapse:collapse;width:100%;font-size:.9rem}th,td{padding:10px;text-align:left;vertical-align:top;border-bottom:1px solid #ddd}td pre{margin:0}footer{margin-top:40px}@media(max-width:700px){header,main{padding:20px}article{padding:16px}nav ul{columns:1}table{display:block;overflow:auto}}</style></head>
  <body><header><p>CARD KEEPR · API REFERENCE</p><h1>${escape(document.info.title)}</h1><p>${escape(document.info.description)}</p>
  <p><strong>Server</strong> <code>${escape(`${base.origin}${base.basePath}`)}</code></p>
  <p>${access === "public" ? "Catalogue reads require your consumer bearer key. This reference is publicly readable." : "Owner operations require your administration bearer key. Signed deployment operations use their separately documented Workflow credentials. This protected reference includes all schemas and styles for offline reading."}</p>
  <p>Specification: <a href="${escape(publicUrl(base, "/openapi.json"))}">${escape(publicUrl(base, "/openapi.json"))}</a>${access === "owner" ? " (send the same administration Authorization header when downloading)." : ""}</p>
  <details><summary>Authentication schemes</summary>${schemaMarkup(document.components?.securitySchemes ?? {})}</details>
  <nav aria-label="Operations"><h2>Operations</h2><ul>${operations.map(({ path, method, operation }) => `<li><a href="#${escape(object(operation).operationId)}"><span class="method">${escape(method.toUpperCase())}</span> ${escape(path)}</a></li>`).join("")}</ul></nav></header>
  <main>${operations.map(({ path, method, operation }) => operationMarkup(path, method, operation)).join("")}<section aria-label="Schemas"><h2>Schemas</h2>${Object.entries(
    document.components?.schemas ?? {},
  )
    .map(
      ([name, schema]) =>
        `<details id="schema-${escape(name)}"><summary>${escape(name)}</summary>${schemaMarkup(schema)}</details>`,
    )
    .join(
      "",
    )}</section><footer>Use your browser’s find command to locate an operation or field. Expand a response or schema to inspect its complete contract.</footer></main></body></html>`;
}
