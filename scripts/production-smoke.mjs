#!/usr/bin/env node

export async function runProductionSmoke(input, fetchImpl = fetch) {
  validateInput(input);
  // apiUrl is a base that may carry a path (https://card.keepr.digital/api);
  // route paths are appended to it rather than resolved against it.
  const base = new URL(input.apiUrl);
  const apiUrl = (path) => new URL(`${base.href.replace(/\/+$/u, "")}${path}`);
  const authorized = { authorization: `Bearer ${input.apiKey}` };
  await expectStatus(fetchImpl, apiUrl("/health"), authorized, 200);
  await expectStatus(fetchImpl, apiUrl("/health"), { authorization: "Bearer deliberately-invalid" }, 401);

  const catalogue = await expectJson(fetchImpl, apiUrl("/v1/catalogue"), authorized, 200, input.currentRevisionId);
  if (catalogue.meta?.catalogue_revision_id !== input.currentRevisionId) throw new Error("current_revision_mismatch");
  const current = input.revisions[0];
  await expectJson(fetchImpl, apiUrl(`/v1/cards/${encodeURIComponent(current.card_id)}`), authorized, 200, input.currentRevisionId);
  await expectJson(fetchImpl, apiUrl(`/v1/printings/${encodeURIComponent(current.printing_id)}`), authorized, 200, input.currentRevisionId);
  await expectJson(fetchImpl, apiUrl(`/v1/legality-status?card_id=${encodeURIComponent(input.legalityCardId)}&on=${encodeURIComponent(input.legalityDate)}&format=${encodeURIComponent(input.legalityFormat)}&region=${encodeURIComponent(input.legalityRegion)}`), authorized, 200, input.currentRevisionId);
  await expectStatus(fetchImpl, apiUrl(`/v1/printing-images/${encodeURIComponent(input.printingImageId)}/content`), authorized, 200, input.currentRevisionId);
  let currentExport;
  for (const fixture of input.revisions) {
    const cards = await expectJson(fetchImpl, apiUrl(`/v1/cards?after=${encodeURIComponent(fixture.card_cursor)}`), authorized, 200, fixture.revision_id);
    assertRevisionCollection(cards, fixture.revision_id, fixture.card_id, "card");
    const search = await expectJson(fetchImpl, apiUrl(`/v1/cards?q=${encodeURIComponent(fixture.search_query)}&after=${encodeURIComponent(fixture.search_cursor)}`), authorized, 200, fixture.revision_id);
    assertRevisionCollection(search, fixture.revision_id, fixture.card_id, "search");
    const printings = await expectJson(fetchImpl, apiUrl(`/v1/printings?after=${encodeURIComponent(fixture.printing_cursor)}`), authorized, 200, fixture.revision_id);
    assertRevisionCollection(printings, fixture.revision_id, fixture.printing_id, "printing");
    const exported = await expectJson(fetchImpl, apiUrl(`/v1/catalogue-exports/${encodeURIComponent(fixture.revision_id)}`), authorized, 200, fixture.revision_id);
    if (fixture.revision_id === input.currentRevisionId) currentExport = exported;
  }
  const component = currentExport?.data?.components?.[0]?.name;
  if (typeof component !== "string") throw new Error("catalogue_export_component_missing");
  await expectStatus(fetchImpl, apiUrl(`/v1/catalogue-exports/${encodeURIComponent(input.currentRevisionId)}/components/${encodeURIComponent(component)}`), authorized, 200, input.currentRevisionId);
  const stale = await expectJson(fetchImpl, apiUrl(`/v1/cards?after=${encodeURIComponent(input.staleCursor)}`), authorized, 409);
  if (stale.code !== "cursor_revision_unavailable") throw new Error("stale_cursor_did_not_fail_predictably");
  return { contract: "card-keepr-production-smoke@1", revision_id: input.currentRevisionId, revision_ids: input.revisions.map((item) => item.revision_id), stale_revision_id: input.staleRevisionId, checks: 21 };
}

function validateInput(input) {
  if (input === null || typeof input !== "object" || !Array.isArray(input.revisions) || input.revisions.length !== 3 ||
      input.revisions[0]?.revision_id !== input.currentRevisionId || new Set(input.revisions.map((item) => item?.revision_id)).size !== 3 ||
      input.revisions.some((item) => item === null || typeof item !== "object" ||
        [item.revision_id, item.card_id, item.printing_id, item.search_query, item.card_cursor, item.search_cursor, item.printing_cursor].some((value) => typeof value !== "string" || value.length === 0)) ||
      [input.apiUrl, input.apiKey, input.printingImageId, input.legalityCardId, input.legalityDate, input.legalityFormat, input.legalityRegion, input.staleCursor, input.staleRevisionId]
        .some((value) => typeof value !== "string" || value.length === 0) ||
      input.revisions.some((item) => item.revision_id === input.staleRevisionId)) throw new Error("invalid_smoke_input");
  try {
    const decoded = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(input.staleCursor), (character) => character.charCodeAt(0))));
    if (decoded.revision_id !== input.staleRevisionId) throw new Error("stale_revision_mismatch");
  } catch (error) {
    if (error?.message === "stale_revision_mismatch") throw error;
    throw new Error("invalid_stale_cursor");
  }
}

function assertRevisionCollection(document, revision, expectedId, kind) {
  if (document.meta?.catalogue_revision_id !== revision || !Array.isArray(document.data) ||
      !document.data.some((item) => item?.id === expectedId)) throw new Error(`${kind}_revision_fixture_mismatch`);
}

async function expectStatus(fetchImpl, url, headers, status, revision) {
  const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (response.status !== status) throw new Error(`smoke_http_${response.status}_${url.pathname}`);
  if (revision !== undefined && response.headers.get("x-catalogue-revision") !== revision) throw new Error(`smoke_revision_header_${url.pathname}`);
  return response;
}

async function expectJson(fetchImpl, url, headers, status, revision) {
  const response = await expectStatus(fetchImpl, url, headers, status, revision);
  return response.json();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const input = JSON.parse(process.env.KEEPR_SMOKE_INPUT ?? "null");
  if (input === null) throw new Error("KEEPR_SMOKE_INPUT is required");
  process.stdout.write(`${JSON.stringify(await runProductionSmoke(input))}\n`);
}
