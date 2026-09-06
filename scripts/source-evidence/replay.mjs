// Offline owner evidence-pack check. Deliberately independent of production adapters.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "parse5";

const directory = resolve(process.argv[2] ?? "acceptance/fixtures/real-sources/2026-09-06");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const attr = (node, key) => node.attrs?.find((attribute) => attribute.name === key)?.value;
function nodes(node, predicate) {
  return [...(predicate(node) ? [node] : []), ...(node.childNodes ?? []).flatMap((child) => nodes(child, predicate))];
}
function nextData(body) {
  const script = nodes(parse(body), (node) => attr(node, "id") === "__NEXT_DATA__");
  assert.equal(script.length, 1, "one retained Next data payload required");
  return JSON.parse(script[0].childNodes[0].value);
}

try {
  const manifest = JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf8"));
  assert.equal(manifest.classification, "retained-real-source-evidence");
  const bodies = new Map();
  let retainedBytes = 0;
  for (const capture of manifest.captures) {
    assert(!bodies.has(capture.id), `duplicate capture ${capture.id}`);
    const body = await readFile(resolve(directory, capture.body));
    const headers = await readFile(resolve(directory, capture.headers));
    assert.equal(body.length, capture.bytes, `${capture.id}: body size`);
    assert.equal(sha256(body), capture.sha256, `${capture.id}: body digest`);
    assert.equal(sha256(headers), capture.headersSha256, `${capture.id}: headers digest`);
    assert.equal(capture.status, 200, `${capture.id}: successful response required`);
    assert(Number.isFinite(Date.parse(capture.startedAt)), `${capture.id}: capture timestamp`);
    assert(Date.parse(capture.completedAt) >= Date.parse(capture.startedAt), `${capture.id}: capture interval`);
    bodies.set(capture.id, body.toString("utf8"));
    retainedBytes += body.length + headers.length;
  }
  const bandai = parse(bodies.get("bandai-p001"));
  const bandaiRecordIds = nodes(bandai, (node) => node.tagName === "dl" && attr(node, "class") === "modalCol").map(
    (node) => attr(node, "id"),
  );
  assert.deepEqual(bandaiRecordIds, manifest.coverage.bandai.recordIds, "complete declared Bandai record census");
  const limitless = parse(bodies.get("limitless-p001"));
  const variants = new Set(
    nodes(
      limitless,
      (node) => node.tagName === "a" && /^\/cards\/en\/P-001\?v=\d+$/.test(attr(node, "href") ?? ""),
    ).map((node) => attr(node, "href")),
  );
  assert.deepEqual(
    [...variants],
    Array.from({ length: 7 }, (_, index) => `/cards/en/P-001?v=${index + 1}`),
  );
  for (let variant = 0; variant < 8; variant++) {
    const id = variant === 0 ? "limitless-p001" : `limitless-p001-v${variant}`;
    assert(bodies.has(id), `required variant missing: ${id}`);
    const page = parse(bodies.get(id));
    const image = nodes(page, (node) => node.tagName === "meta" && attr(node, "property") === "og:image");
    assert.equal(image.length, 1, `${id}: selected image required`);
    const capture = manifest.captures.find((entry) => entry.id === `limitless-p001-image-${variant}`);
    assert.equal(capture?.url, attr(image[0], "content"), `${id}: retained selected image`);
  }
  const bandaiRecords = nodes(bandai, (node) => node.tagName === "dl" && attr(node, "class") === "modalCol");
  for (const [index, record] of bandaiRecords.entries()) {
    const image = nodes(record, (node) => node.tagName === "img" && attr(node, "data-src"));
    assert.equal(image.length, 1, `${bandaiRecordIds[index]}: record image required`);
    const source = manifest.captures.find((entry) => entry.id === "bandai-p001");
    const capture = manifest.captures.find((entry) => entry.id === `bandai-p001-image-${index}`);
    assert.equal(
      capture?.url,
      new URL(attr(image[0], "data-src"), source.url).href,
      `${bandaiRecordIds[index]}: retained record image`,
    );
  }
  const cards = nextData(bodies.get("riftbound-gallery")).props.pageProps.page.blades.flatMap(
    (blade) => blade.cards?.items ?? [],
  );
  assert.equal(cards.length, manifest.coverage.riftbound.records, "complete retained gallery census");
  assert.equal(new Set(cards.map((card) => card.id)).size, cards.length, "gallery source IDs unique");
  const riftboundBySet = {};
  for (const card of cards) riftboundBySet[card.set.value.id] = (riftboundBySet[card.set.value.id] ?? 0) + 1;
  assert.deepEqual(riftboundBySet, manifest.coverage.riftbound.bySet);
  for (const scope of Object.values(manifest.coverage)) {
    for (const id of scope.images) assert(bodies.has(id), `required image missing: ${id}`);
  }
  for (const gate of Object.values(manifest.gates)) {
    for (const id of gate.evidence ?? []) assert(bodies.has(id), `gate evidence missing: ${id}`);
  }
  const facts = JSON.parse(await readFile(resolve(directory, "expected-facts.json"), "utf8"));
  for (const [id, expected] of Object.entries(facts.riftbound)) {
    const card = cards.find((entry) => entry.id === id);
    assert(card, `required representative gallery record: ${id}`);
    for (const [field, value] of Object.entries(expected)) assert.deepEqual(card[field], value, `${id}: ${field}`);
    const capture = manifest.captures.find((entry) => entry.id === `riftbound-image-${id}`);
    assert.equal(capture?.url, card.cardImage.url, `${id}: retained image belongs to source record`);
  }
  for (const [id, expected] of Object.entries(facts.articles)) {
    const article = nextData(bodies.get(id)).props.pageProps.page.blades[2].richText.body;
    const text = nodes(parse(article), (node) => node.nodeName === "#text")
      .map((node) => node.value)
      .join(" ");
    for (const [fact, snippet] of Object.entries(expected)) assert(text.includes(snippet), `${id}: ${fact}`);
  }
  const syntheticAdmission = JSON.parse(await readFile(resolve(directory, "synthetic-admission.json"), "utf8"));
  assert.equal(syntheticAdmission.classification, "synthetic-admission-scenarios");
  console.log(
    JSON.stringify(
      {
        classification: manifest.classification,
        facts,
        syntheticAdmission,
        captures: bodies.size,
        retainedBytes,
        census: {
          bandaiRecordIds,
          limitlessPrintEntries: variants.size + 1,
          riftboundRecords: cards.length,
          riftboundBySet,
        },
        gates: manifest.gates,
        visualReview: "Retained review findings, not an automated image-equivalence decision; inspect comparison.html.",
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(`Evidence replay failed: ${error.message}`);
  process.exitCode = 1;
}
