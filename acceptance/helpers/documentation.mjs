import assert from "node:assert/strict";

export function documentationResponse(url, init) {
  const parsed = new URL(url);
  if (!/\/(docs|openapi\.json)$/.test(parsed.pathname)) return null;
  assert.equal(init.headers.authorization, undefined);
  if (parsed.pathname.startsWith("/ingest/"))
    return new Response(JSON.stringify({ code: "authentication_required" }), { status: 401 });
  if (parsed.pathname.endsWith("/docs"))
    return new Response(
      `<!doctype html><html><a href="${String(url).replace(/docs$/, "openapi.json")}">OpenAPI</a></html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  return Response.json({
    openapi: "3.1.0",
    servers: [{ url: String(url).replace(/\/openapi\.json$/, "") }],
    paths: { "/v1/games": { get: { security: [{ bearerAuth: [] }] } }, "/docs": { get: { security: [] } } },
  });
}
