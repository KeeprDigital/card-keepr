import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const root = new URL("./fixtures/real-sources/2026-09-08-riftbound/", import.meta.url);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("retained Riot public English pagination exhausts exact links without inventing metadata records", async () => {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
  const pages = [];
  let bodyBytes = 0;
  let headerBytes = 0;
  for (const capture of manifest.captures) {
    const body = await readFile(new URL(capture.body, root));
    const headers = await readFile(new URL(capture.headers, root));
    assert.equal(hash(body), capture.sha256);
    assert.equal(hash(headers), capture.headersSha256);
    assert.equal(body.byteLength, capture.bytes);
    assert.equal(capture.status, 200);
    assert.ok(Date.parse(capture.completedAt) >= Date.parse(capture.startedAt));
    bodyBytes += body.byteLength;
    headerBytes += headers.byteLength;
    if (capture.id.startsWith("riftbound-cards-")) pages.push({ capture, document: JSON.parse(body) });
  }
  assert.equal(bodyBytes, 3249095);
  assert.equal(headerBytes, 5973);
  assert.equal(pages.length, 6);
  const records = [];
  for (const [index, { capture, document }] of pages.entries()) {
    assert.equal(document.metadata.from, index * 200);
    assert.equal(document.metadata.locale, "en-us");
    assert.equal(document.metadata.totalItems, 1197);
    assert.equal(document.metadata.totalPages, 6);
    assert.equal(new URL(document.linkdata.self, capture.url).href, capture.url);
    assert.equal(
      document.linkdata.next == null ? null : new URL(document.linkdata.next, capture.url).href,
      pages[index + 1]?.capture.url ?? null,
    );
    records.push(...document.data);
  }
  assert.deepEqual(
    pages.map((p) => p.document.data.length),
    [200, 198, 200, 198, 198, 195],
  );
  assert.equal(records.length, 1189);
  assert.equal(new Set(records.map((r) => r.id)).size, 1189);
  const old = await readFile(
    new URL("./fixtures/real-sources/2026-09-06/raw/riftbound-gallery.body", import.meta.url),
    "utf8",
  );
  const embedded = JSON.parse(old.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)[1]);
  const oldRecords = embedded.props.pageProps.page.blades.flatMap((b) => b.cards?.items ?? []);
  assert.deepEqual(records.map((r) => r.id).sort(), oldRecords.map((r) => r.id).sort());
});
