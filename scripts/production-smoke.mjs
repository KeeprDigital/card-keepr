#!/usr/bin/env node

export async function runProductionSmoke(input, fetchImpl = fetch) {
  const base = new URL(input.apiUrl);
  const authorized = { authorization: `Bearer ${input.apiKey}` };
  await expectStatus(fetchImpl, new URL("/health", base), authorized, 200);
  await expectStatus(fetchImpl, new URL("/health", base), { authorization: "Bearer deliberately-invalid" }, 401);

  const catalogue = await expectJson(fetchImpl, new URL("/v1/catalogue", base), authorized, 200, input.currentRevisionId);
  if (catalogue.meta?.catalogue_revision_id !== input.currentRevisionId) throw new Error("current_revision_mismatch");
  await expectJson(fetchImpl, new URL(`/v1/cards/${encodeURIComponent(input.cardId)}`, base), authorized, 200, input.currentRevisionId);
  await expectJson(fetchImpl, new URL(`/v1/printings/${encodeURIComponent(input.printingId)}`, base), authorized, 200, input.currentRevisionId);
  await expectJson(fetchImpl, new URL(`/v1/cards?q=${encodeURIComponent(input.searchQuery)}`, base), authorized, 200, input.currentRevisionId);
  await expectJson(fetchImpl, new URL(`/v1/legality-status?card_id=${encodeURIComponent(input.legalityCardId)}&on=${encodeURIComponent(input.legalityDate)}&format=${encodeURIComponent(input.legalityFormat)}&region=${encodeURIComponent(input.legalityRegion)}`, base), authorized, 200, input.currentRevisionId);
  const exported = await expectJson(fetchImpl, new URL(`/v1/catalogue-exports/${encodeURIComponent(input.currentRevisionId)}`, base), authorized, 200, input.currentRevisionId);
  const component = exported.data?.components?.[0]?.name;
  if (typeof component !== "string") throw new Error("catalogue_export_component_missing");
  await expectStatus(fetchImpl, new URL(`/v1/catalogue-exports/${encodeURIComponent(input.currentRevisionId)}/components/${encodeURIComponent(component)}`, base), authorized, 200, input.currentRevisionId);
  await expectStatus(fetchImpl, new URL(`/v1/printing-images/${encodeURIComponent(input.printingImageId)}/content`, base), authorized, 200, input.currentRevisionId);
  for (const revision of input.retainedRevisionIds) {
    await expectJson(fetchImpl, new URL(`/v1/catalogue-exports/${encodeURIComponent(revision)}`, base), authorized, 200, revision);
  }
  if (input.staleCursor) {
    const stale = await expectJson(fetchImpl, new URL(`/v1/cards?after=${encodeURIComponent(input.staleCursor)}`, base), authorized, 409);
    if (stale.code !== "cursor_revision_unavailable") throw new Error("stale_cursor_did_not_fail_predictably");
  }
  return { contract: "card-keepr-production-smoke@1", revision_id: input.currentRevisionId, checks: 10 + input.retainedRevisionIds.length + (input.staleCursor ? 1 : 0) };
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
