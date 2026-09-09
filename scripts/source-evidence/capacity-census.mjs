// Offline census of immutable retained response bodies, never a network capture
// or a production capacity claim. Read/verify one response at a time.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "parse5";
import { syntheticCapacityWorkloads, capacityPageCount } from "../../test/support/fake-publisher/capacity-workloads.ts";
import { capacityStorageBudget } from "../../acceptance/helpers/capacity-storage-budget.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const attr = (node, name) => node.attrs?.find((attribute) => attribute.name === name)?.value;
function* nodes(node) {
  yield node;
  for (const child of node.childNodes ?? []) yield* nodes(child);
}
const root = resolve(import.meta.dirname, "../..");

export async function retainedSourceCensus(repository = root) {
  const packs = ["2026-09-06", "2026-09-08-riftbound"];
  const captures = [];
  const manifests = [];
  const bandaiRecords = [];
  const limitlessRecords = [];
  const riftboundIds = new Set();
  const riftboundImages = new Set();
  const riftboundPages = [];
  const bySet = {};
  let sets = 0;
  for (const pack of packs) {
    const directory = `acceptance/fixtures/real-sources/${pack}`;
    const manifestBytes = await readFile(resolve(repository, directory, "manifest.json"));
    manifests.push({ path: `${directory}/manifest.json`, sha256: sha256(manifestBytes) });
    const manifest = JSON.parse(manifestBytes);
    for (const capture of manifest.captures) {
      const body = await readFile(resolve(repository, directory, capture.body));
      const headers = await readFile(resolve(repository, directory, capture.headers));
      assert.equal(body.length, capture.bytes, `${capture.id}: body size`);
      assert.equal(sha256(body), capture.sha256, `${capture.id}: body digest`);
      assert.equal(sha256(headers), capture.headersSha256, `${capture.id}: header digest`);
      assert.equal(capture.status, 200, `${capture.id}: response status`);
      captures.push({
        id: capture.id,
        pack,
        url: capture.url,
        body: `${directory}/${capture.body}`,
        body_bytes: body.length,
        header_bytes: headers.length,
        sha256: capture.sha256,
        headers_sha256: capture.headersSha256,
        image: capture.contentType.startsWith("image/"),
        started_at: capture.startedAt,
        completed_at: capture.completedAt,
      });
      if (capture.id === "bandai-p001") {
        for (const node of nodes(parse(body.toString()))) {
          if (node.tagName !== "dl" || attr(node, "class") !== "modalCol") continue;
          const images = [...nodes(node)].filter((entry) => entry.tagName === "img" && attr(entry, "data-src"));
          assert.equal(images.length, 1);
          bandaiRecords.push({
            id: attr(node, "id"),
            image_url: new URL(attr(images[0], "data-src"), capture.url).href,
          });
        }
      }
      if (/^limitless-p001(?:-v[1-7])?$/u.test(capture.id)) {
        const images = [...nodes(parse(body.toString()))].filter(
          (node) => node.tagName === "meta" && attr(node, "property") === "og:image",
        );
        assert.equal(images.length, 1);
        limitlessRecords.push({ id: capture.id, image_url: attr(images[0], "content") });
      }
      if (capture.id.startsWith("riftbound-cards-")) {
        const page = JSON.parse(body);
        riftboundPages.push({
          id: capture.id,
          from: page.metadata.from,
          returned_records: page.data.length,
          publisher_reported_records: page.metadata.totalItems,
          next: page.linkdata.next ?? null,
        });
        for (const card of page.data) {
          assert(!riftboundIds.has(card.id), `duplicate Riftbound record ${card.id}`);
          riftboundIds.add(card.id);
          assert.equal(typeof card.cardImage.url, "string");
          riftboundImages.add(card.cardImage.url);
          bySet[card.set.value.id] = (bySet[card.set.value.id] ?? 0) + 1;
        }
      }
      if (capture.id === "riftbound-sets") sets = JSON.parse(body).data.length;
    }
  }
  const totals = (entries) => ({
    responses: entries.length,
    document_responses: entries.filter((entry) => !entry.image).length,
    image_responses: entries.filter((entry) => entry.image).length,
    document_body_bytes: entries.filter((entry) => !entry.image).reduce((sum, entry) => sum + entry.body_bytes, 0),
    image_body_bytes: entries.filter((entry) => entry.image).reduce((sum, entry) => sum + entry.body_bytes, 0),
    header_bytes: entries.reduce((sum, entry) => sum + entry.header_bytes, 0),
  });
  const scope = (records, pattern) => {
    const retained = captures.filter((capture) => pattern.test(capture.id));
    const images = new Set(retained.filter((capture) => capture.image).map((capture) => capture.url));
    for (const record of records) assert(images.has(record.image_url), `unretained required image: ${record.id}`);
    return {
      source_records: records.length,
      unique_image_urls: new Set(records.map((record) => record.image_url)).size,
      ...totals(retained),
      records,
    };
  };
  const retainedRiftboundImages = captures.filter(
    (capture) => capture.image && capture.id.startsWith("riftbound-image-"),
  );
  for (const capture of retainedRiftboundImages)
    assert(riftboundImages.has(capture.url), `${capture.id}: image outside inventory`);
  riftboundPages.sort((a, b) => a.from - b.from);
  for (const [index, page] of riftboundPages.entries()) {
    const next = riftboundPages[index + 1];
    if (next) {
      const nextCapture = captures.find((capture) => capture.id === next.id);
      assert.equal(new URL(page.next, nextCapture.url).href, nextCapture.url, `${page.id}: next page retained`);
    } else assert.equal(page.next, null, "last returned Riftbound page must terminate");
  }
  return {
    contract: "card-keepr-retained-capacity-census@1",
    manifests,
    scope:
      "Immutable retained English response inventories. One Piece is bounded P-001 on Bandai and Limitless plus separate trophy corroboration; Riftbound is all returned mapper pages, not every issued Printing. Source records are not canonical Card/Printing counts.",
    one_piece: {
      bandai_p001: scope(bandaiRecords, /^bandai-p001/u),
      limitless_p001: scope(limitlessRecords, /^limitless-p001/u),
      bandai_trophy_corroboration: totals(captures.filter((capture) => capture.id.startsWith("bandai-store-"))),
      limitation:
        "Seven official and eight supplemental source entries are overlapping appearances, not fifteen distinct Printings. Complete One Piece game inventory and its byte budget are unknown.",
    },
    riftbound: {
      source_records: riftboundIds.size,
      unique_image_urls: riftboundImages.size,
      retained_image_urls: retainedRiftboundImages.length,
      unretained_image_urls: riftboundImages.size - retainedRiftboundImages.length,
      unretained_image_bytes: null,
      by_set: bySet,
      sets,
      pages: riftboundPages,
      mapper_inventory: totals(captures.filter((capture) => capture.pack === "2026-09-08-riftbound")),
      representative_images: totals(retainedRiftboundImages),
      corroboration: totals(
        captures.filter((capture) =>
          ["riftbound-errata", "riftbound-products", "riftbound-preview"].includes(capture.id),
        ),
      ),
      historical_embedded_gallery: totals(captures.filter((capture) => capture.id === "riftbound-gallery")),
      limitation:
        "Publisher metadata reports 1,197; the linked pages return 1,189 unique records. Eight unreturned records remain unexplained. Missing image bytes have not been estimated from six samples. Historical gallery bytes are separate from the mapper workload.",
    },
    all_retained_inputs: totals(captures),
    captures,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const census = await retainedSourceCensus(process.argv[2] ? resolve(process.argv[2]) : root);
  console.log(
    JSON.stringify(
      {
        ...census,
        synthetic: syntheticCapacityWorkloads.map((workload) => ({
          ...workload,
          pages: capacityPageCount(workload),
          source_requests: capacityPageCount(workload) + workload.images,
          storage_budget: capacityStorageBudget(workload),
        })),
      },
      null,
      2,
    ),
  );
}
