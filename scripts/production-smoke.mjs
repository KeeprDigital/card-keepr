#!/usr/bin/env node
import { request as httpRequest } from "../cli/lib/http-client.mjs";
import { runtimeUrl } from "../cli/command-support.mjs";
import { SPINE_REVISION_ID } from "../src/catalogue/shared/spine-revision.mjs";

// Bootstrap Mode (issue #141): before the first published Catalogue Revision
// there is no Card, Printing, export, or retained revision to read, so the
// smoke proves only that both mounts answer, enforce authentication, and
// that the API reports the Spine Revision.
export async function runBootstrapSmoke(input, fetchImpl = fetch) {
  if (
    input === null ||
    typeof input !== "object" ||
    [input.apiUrl, input.apiKey, input.ingestionUrl, input.currentRevisionId].some(
      (value) => typeof value !== "string" || value.length === 0,
    ) ||
    input.currentRevisionId !== SPINE_REVISION_ID
  )
    throw new Error("invalid_smoke_input");
  const apiUrl = (path) => runtimeUrl(input.apiUrl, path);
  const ingestionUrl = (path) => runtimeUrl(input.ingestionUrl, path);
  const authorized = { authorization: `Bearer ${input.apiKey}` };
  await expectReadiness(fetchImpl, apiUrl("/health"), authorized, "api");
  await expectStatus(fetchImpl, apiUrl("/health"), { authorization: "Bearer deliberately-invalid" }, 401);
  // The workflow holds no administration credential. An unauthenticated 401
  // problem from the ingestion mount proves the route reaches the Worker and
  // that it enforces authentication; the placeholder origin never answers so.
  const unauthenticated = await expectJson(fetchImpl, ingestionUrl("/health"), {}, 401);
  if (unauthenticated.code !== "authentication_required") throw new Error("ingestion_authentication_not_enforced");
  await expectLiveness(fetchImpl, apiUrl("/healthz"), "api");
  await expectLiveness(fetchImpl, ingestionUrl("/healthz"), "ingestion");
  const catalogue = await expectJson(fetchImpl, apiUrl("/v1/catalogue"), authorized, 200, SPINE_REVISION_ID);
  if (catalogue.meta?.catalogue_revision_id !== SPINE_REVISION_ID) throw new Error("current_revision_mismatch");
  return { contract: "card-keepr-production-bootstrap-smoke@1", revision_id: SPINE_REVISION_ID, checks: 6 };
}

export async function runProductionSmoke(input, fetchImpl = fetch) {
  validateInput(input);
  const apiUrl = (path) => runtimeUrl(input.apiUrl, path);
  const authorized = { authorization: `Bearer ${input.apiKey}` };
  await expectReadiness(fetchImpl, apiUrl("/health"), authorized, "api");
  await expectStatus(fetchImpl, apiUrl("/health"), { authorization: "Bearer deliberately-invalid" }, 401);
  await expectLiveness(fetchImpl, apiUrl("/healthz"), "api");

  const catalogue = await expectJson(fetchImpl, apiUrl("/v1/catalogue"), authorized, 200, input.currentRevisionId);
  if (catalogue.meta?.catalogue_revision_id !== input.currentRevisionId) throw new Error("current_revision_mismatch");
  const current = input.revisions[0];
  await expectJson(
    fetchImpl,
    apiUrl(`/v1/cards/${encodeURIComponent(current.card_id)}`),
    authorized,
    200,
    input.currentRevisionId,
  );
  await expectJson(
    fetchImpl,
    apiUrl(`/v1/printings/${encodeURIComponent(current.printing_id)}`),
    authorized,
    200,
    input.currentRevisionId,
  );
  await expectStatus(
    fetchImpl,
    apiUrl(`/v1/printing-images/${encodeURIComponent(input.printingImageId)}/content`),
    authorized,
    200,
    input.currentRevisionId,
  );
  let currentExport;
  for (const fixture of input.revisions) {
    const cards = await expectJson(
      fetchImpl,
      apiUrl(`/v1/cards?after=${encodeURIComponent(fixture.card_cursor)}`),
      authorized,
      200,
      fixture.revision_id,
    );
    assertRevisionCollection(cards, fixture.revision_id, fixture.card_id, "card");
    const search = await expectJson(
      fetchImpl,
      apiUrl(
        `/v1/cards?q=${encodeURIComponent(fixture.search_query)}&after=${encodeURIComponent(fixture.search_cursor)}`,
      ),
      authorized,
      200,
      fixture.revision_id,
    );
    assertRevisionCollection(search, fixture.revision_id, fixture.card_id, "search");
    const printings = await expectJson(
      fetchImpl,
      apiUrl(`/v1/printings?after=${encodeURIComponent(fixture.printing_cursor)}`),
      authorized,
      200,
      fixture.revision_id,
    );
    assertRevisionCollection(printings, fixture.revision_id, fixture.printing_id, "printing");
    const exported = await expectJson(
      fetchImpl,
      apiUrl(`/v1/catalogue-exports/${encodeURIComponent(fixture.revision_id)}`),
      authorized,
      200,
      fixture.revision_id,
    );
    if (fixture.revision_id === input.currentRevisionId) currentExport = exported;
  }
  const component = currentExport?.data?.components?.[0]?.name;
  if (typeof component !== "string") throw new Error("catalogue_export_component_missing");
  await expectStatus(
    fetchImpl,
    apiUrl(
      `/v1/catalogue-exports/${encodeURIComponent(input.currentRevisionId)}/components/${encodeURIComponent(component)}`,
    ),
    authorized,
    200,
    input.currentRevisionId,
  );
  const stale = await expectJson(
    fetchImpl,
    apiUrl(`/v1/cards?after=${encodeURIComponent(input.staleCursor)}`),
    authorized,
    409,
  );
  if (stale.code !== "cursor_revision_unavailable") throw new Error("stale_cursor_did_not_fail_predictably");
  return {
    contract: "card-keepr-production-smoke@1",
    revision_id: input.currentRevisionId,
    revision_ids: input.revisions.map((item) => item.revision_id),
    stale_revision_id: input.staleRevisionId,
    checks: 22,
  };
}

// Readiness (issue #144): the authenticated health document proves the
// deployed bindings; a degraded document answers 503 and fails the smoke.
async function expectReadiness(fetchImpl, url, headers, runtime) {
  const document = await expectJson(fetchImpl, url, headers, 200);
  if (
    document.status !== "ok" ||
    document.runtime !== runtime ||
    typeof document.checks !== "object" ||
    document.checks === null
  )
    throw new Error(`smoke_not_ready_${url.pathname}`);
  return document;
}

// Liveness: the unauthenticated probe monitors watch.
async function expectLiveness(fetchImpl, url, runtime) {
  const document = await expectJson(fetchImpl, url, {}, 200);
  if (document.status !== "ok" || document.runtime !== runtime) throw new Error(`smoke_not_live_${url.pathname}`);
  return document;
}

function validateInput(input) {
  if (
    input === null ||
    typeof input !== "object" ||
    !Array.isArray(input.revisions) ||
    input.revisions.length !== 3 ||
    input.revisions[0]?.revision_id !== input.currentRevisionId ||
    new Set(input.revisions.map((item) => item?.revision_id)).size !== 3 ||
    input.revisions.some(
      (item) =>
        item === null ||
        typeof item !== "object" ||
        [
          item.revision_id,
          item.card_id,
          item.printing_id,
          item.search_query,
          item.card_cursor,
          item.search_cursor,
          item.printing_cursor,
        ].some((value) => typeof value !== "string" || value.length === 0),
    ) ||
    [input.apiUrl, input.apiKey, input.printingImageId, input.staleCursor, input.staleRevisionId].some(
      (value) => typeof value !== "string" || value.length === 0,
    ) ||
    input.revisions.some((item) => item.revision_id === input.staleRevisionId)
  )
    throw new Error("invalid_smoke_input");
  try {
    const decoded = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(atob(input.staleCursor), (character) => character.charCodeAt(0))),
    );
    if (decoded.revision_id !== input.staleRevisionId) throw new Error("stale_revision_mismatch");
  } catch (error) {
    if (error?.message === "stale_revision_mismatch") throw error;
    throw new Error("invalid_stale_cursor", { cause: error });
  }
}

function assertRevisionCollection(document, revision, expectedId, kind) {
  if (
    document.meta?.catalogue_revision_id !== revision ||
    !Array.isArray(document.data) ||
    !document.data.some((item) => item?.id === expectedId)
  )
    throw new Error(`${kind}_revision_fixture_mismatch`);
}

async function expectStatus(fetchImpl, url, headers, status, revision) {
  const response = await httpRequest(url, { headers, signal: AbortSignal.timeout(15_000) }, fetchImpl);
  if (response.status !== status) throw new Error(`smoke_http_${response.status}_${url.pathname}`);
  if (revision !== undefined && response.headers.get("x-catalogue-revision") !== revision)
    throw new Error(`smoke_revision_header_${url.pathname}`);
  return response;
}

async function expectJson(fetchImpl, url, headers, status, revision) {
  const response = await expectStatus(fetchImpl, url, headers, status, revision);
  return response.json();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const input = JSON.parse(process.env.KEEPR_SMOKE_INPUT ?? "null");
  if (input === null) throw new Error("KEEPR_SMOKE_INPUT is required");
  const run = process.argv[2] === "bootstrap" ? runBootstrapSmoke : runProductionSmoke;
  process.stdout.write(`${JSON.stringify(await run(input))}\n`);
}
