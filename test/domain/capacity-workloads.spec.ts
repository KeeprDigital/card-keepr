import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { capacitySourceResponse, syntheticCapacityTier } from "../support/fake-publisher/capacity-workloads";

test("capacity pages retain the accepted structured bytes and use separate image URLs", async () => {
  const response = capacitySourceResponse(
    new URL("https://official-source.invalid/reconciliation/capacity-tier-1-page-0"),
  )!;
  const text = await response.text();
  expect(Buffer.byteLength(text)).toBe(167773);
  const page = JSON.parse(text);
  expect(page.cards).toHaveLength(16);
  expect(page.cards[0].appearance_evidence.images).toHaveLength(2);
  expect(text).not.toContain("content_base64");
  const url = page.cards[0].appearance_evidence.images[0].source_url;
  const image = capacitySourceResponse(new URL(url))!;
  expect(image.headers.get("content-type")).toBe("image/png");
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of image.body!) {
    expect(chunk.byteLength).toBeLessThanOrEqual(65536);
    bytes += chunk.byteLength;
    hash.update(chunk);
  }
  expect(bytes).toBe(268436);
  expect(hash.digest("hex")).toMatch(/^[a-f0-9]{64}$/);
  expect(syntheticCapacityTier("tier-1").images).toBe(20_000);
});

import { capacitySourceAdapter } from "../support/source-adapters/capacity";

test("capacity collection discovers every separate image and the next bounded page", async () => {
  const url = "https://official-source.invalid/reconciliation/capacity-128-images-page-0";
  const page = await capacitySourceResponse(new URL(url))!.text();
  const extracted = await capacitySourceAdapter.recordExtraction.extract(
    async function* () {
      yield page;
    },
    { url, mediaType: "application/json" },
  );
  expect(extracted.count).toBe(16);
  const requests = [];
  for (const request of extracted.requests) requests.push(request);
  expect(requests.filter((request) => request.role === "image")).toHaveLength(16);
  expect(requests.filter((request) => request.role === "listing")).toEqual([
    {
      role: "listing",
      url: "https://official-source.invalid/reconciliation/capacity-128-images-page-1",
      headers: { accept: "application/json" },
    },
  ]);
  const records = [];
  for await (const record of extracted.records) records.push(record);
  expect(records).toHaveLength(16);
  expect(JSON.stringify(records)).not.toContain("content_base64");
});

import { crc32, inflateSync } from "node:zlib";
import {
  capacityImageResponse,
  capacityPageDocument,
  capacityPageCount,
  capacityByteShare,
  syntheticCapacityWorkloads,
} from "../support/fake-publisher/capacity-workloads";

test("small separately streamed images are complete decodable PNGs with unique deterministic bytes", async () => {
  const workload = { id: "small", printings: 3, images: 6, imageBytes: 601, structuredBytes: 16384 };
  const digests = new Set();
  let total = 0;
  for (let image = 0; image < 6; image++) {
    const bytes = Buffer.from(await capacityImageResponse(workload, image).arrayBuffer());
    total += bytes.length;
    expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    const chunks = [];
    for (let offset = 8; offset < bytes.length; ) {
      const length = bytes.readUInt32BE(offset);
      const type = bytes.toString("ascii", offset + 4, offset + 8);
      expect(crc32(bytes.subarray(offset + 4, offset + 8 + length))).toBe(bytes.readUInt32BE(offset + 8 + length));
      if (type === "IDAT") expect(inflateSync(bytes.subarray(offset + 8, offset + 8 + length))).toHaveLength(5);
      chunks.push(type);
      offset += length + 12;
    }
    expect(chunks).toEqual(["IHDR", "IDAT", "caPy", "IEND"]);
    digests.add(createHash("sha256").update(bytes).digest("hex"));
  }
  expect(total).toBe(601);
  expect(digests.size).toBe(6);
});

test.each(syntheticCapacityWorkloads)(
  "$id preserves its exact census at bounded page and image edges",
  async (workload) => {
    const pages = capacityPageCount(workload);
    let imageBytes = 0;
    for (let index = 0; index < workload.images; index++)
      imageBytes += capacityByteShare(workload.imageBytes, workload.images, index);
    expect(imageBytes).toBe(workload.imageBytes);
    let structuredBytes = 0;
    for (let page = 0; page < pages; page++)
      structuredBytes += capacityByteShare(workload.structuredBytes, pages, page);
    expect(structuredBytes).toBe(workload.structuredBytes);
    for (const page of [0, pages - 1]) {
      const text = JSON.stringify(capacityPageDocument(workload, page));
      expect(Buffer.byteLength(text)).toBe(capacityByteShare(workload.structuredBytes, pages, page));
      expect(text).not.toContain("content_base64");
    }
    const lastUrl = `https://official-source.invalid/reconciliation/capacity-${workload.id}-page-${pages - 1}`;
    const last = await capacitySourceResponse(new URL(lastUrl))!.text();
    const extracted = await capacitySourceAdapter.recordExtraction.extract(
      async function* () {
        yield last;
      },
      { url: lastUrl, mediaType: "application/json" },
    );
    expect(extracted.requests.every((request) => request.role === "image")).toBe(true);
    const image = capacityImageResponse(workload, workload.images - 1);
    expect(image.headers.get("content-length")).toBe(
      String(capacityByteShare(workload.imageBytes, workload.images, workload.images - 1)),
    );
    await image.body!.cancel();
  },
);

test("small parameterized pages preserve final partial pages and reject unsafe fixture bounds", async () => {
  const workload = { id: "small", printings: 3, images: 6, imageBytes: 601, structuredBytes: 16384 };
  const pages = [capacityPageDocument(workload, 0, 2), capacityPageDocument(workload, 1, 2)];
  expect(pages.map((page) => page.cards.length)).toEqual([2, 1]);
  expect(pages.reduce((sum, page) => sum + Buffer.byteLength(JSON.stringify(page)), 0)).toBe(16384);
  expect(() => capacityPageDocument(workload, 2, 2)).toThrow("out of range");
  expect(() => capacityPageDocument(workload, 0, 129)).toThrow("1 to 128");
  expect(() => capacityPageDocument({ ...workload, structuredBytes: 10 ** 9 }, 0)).toThrow("bounded");
  expect(() => capacityByteShare(Number.MAX_SAFE_INTEGER, 0, 0)).toThrow();
  expect(
    capacitySourceResponse(new URL("https://official-source.invalid/images/capacity-tier-1-20000.png"))!.status,
  ).toBe(404);
  const url = "https://official-source.invalid/reconciliation/capacity-128-images-page-0";
  const document = JSON.parse(await capacitySourceResponse(new URL(url))!.text());
  document.cards[0].appearance_evidence.images = [];
  await expect(
    capacitySourceAdapter.recordExtraction.extract(
      async function* () {
        yield JSON.stringify(document);
      },
      { url, mediaType: "application/json" },
    ),
  ).rejects.toThrow("image census");
});
