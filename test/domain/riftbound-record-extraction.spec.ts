import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { riftboundSourceAdapterRegistration as adapter } from "../../src/catalogue/adapters/riftbound-source-adapter";

const url =
  "https://content.publishing.riotgames.com/publishing-content/v2.0/public/channel/riftbound_website/list/riftbound_gallery_cards?locale=en_US&from=0&limit=200";
const source = readFileSync("acceptance/fixtures/real-sources/2026-09-08-riftbound/raw/cards-0.json", "utf8");
function chunks(text: string) {
  return async function* () {
    for (let i = 0; i < text.length; i += 997) yield text.slice(i, i + 997);
  };
}

test("bounded Riot extraction preserves literal records and image URLs across chunk boundaries", async () => {
  const extracted = await adapter.recordExtraction.extract(chunks(source), { url });
  const expected = adapter.parseBytes(new TextEncoder().encode(source), { url, mediaType: "application/json" });
  let ordinal = 0;
  const requests = [...extracted.requests] as { role: string; url: string; headers: Record<string, string> }[];
  for await (const item of extracted.records) {
    expect(item.value).toEqual(expected[ordinal++]);
    requests.push(item.request);
  }
  expect(ordinal).toBe(extracted.count);
  expect(requests).toEqual(
    adapter.discoverRequests(new TextEncoder().encode(source), { url, mediaType: "application/json" }),
  );
});

test("Riot extraction rejects malformed metadata before yielding a record", async () => {
  for (const mutate of [
    (page: { metadata: { locale: string }; linkdata: { next?: string }; data: unknown[] }) => {
      page.metadata.locale = "zh-tw";
    },
    (page: { metadata: { locale: string }; linkdata: { next?: string }; data: unknown[] }) => {
      delete page.linkdata.next;
    },
    (page: { metadata: { locale: string }; linkdata: { next?: string }; data: unknown[] }) => {
      page.data = Array(201).fill(page.data[0]);
    },
  ]) {
    const page = JSON.parse(source);
    mutate(page);
    await expect(adapter.recordExtraction.extract(chunks(JSON.stringify(page)), { url })).rejects.toThrow();
  }
});

test("Riot extraction enforces raw record token and depth bounds before materializing observations", async () => {
  for (const value of [
    "x".repeat(262144),
    Array.from({ length: 40 }).reduce((value) => ({ nested: value }), {} as unknown),
  ]) {
    const page = JSON.parse(source);
    page.data[0].extra = value;
    await expect(adapter.recordExtraction.extract(chunks(JSON.stringify(page)), { url })).rejects.toThrow();
  }
});
