import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { expect, test } from "vitest";
import { requiredSourceAdapter } from "../../src/catalogue/adapters/source-adapters";
import { scryfallBulkPin, scryfallCapturedBulkPin } from "../../src/catalogue/adapters/scryfall-bulk";

const fixture = new URL(
  "../../acceptance/fixtures/real-sources/2026-09-14-scryfall/raw/bulk-metadata.json",
  import.meta.url,
);

test("Scryfall bulk discovery pins the Printing-bearing gzip JSONL transport and advertised size", () => {
  const adapter = requiredSourceAdapter("scryfall-magic-en@1");
  const requests = adapter.discoverRequests!(readFileSync(fixture), {
    url: "https://api.scryfall.com/bulk-data",
    mediaType: "application/json",
  });
  expect(requests).toEqual([
    {
      role: "listing",
      discoveryKey: "bulk-20260914090527-78247919",
      url: "https://data.scryfall.io/default-cards/default-cards-20260914090527.jsonl.gz",
      headers: {
        accept: "application/gzip, application/octet-stream;q=0.9",
        "accept-encoding": "identity",
        "user-agent": "Card-Keepr/0.1 (+https://github.com/KeeprDigital/card-keepr)",
      },
    },
  ]);
});

test.each(["missing", "duplicate", "incomplete", "timestamp", "dataset", "size"])(
  "bulk metadata rejects a %s pin instead of selecting a different inventory",
  (change) => {
    const document = JSON.parse(readFileSync(fixture, "utf8"));
    const selected = document.data.find((entry: { type: string }) => entry.type === "default_cards");
    if (change === "missing")
      document.data = document.data.filter((entry: { type: string }) => entry.type !== "default_cards");
    if (change === "duplicate") document.data.push(selected);
    if (change === "incomplete") document.has_more = true;
    if (change === "timestamp") selected.updated_at = "2026-09-15T09:05:27Z";
    if (change === "dataset")
      selected.jsonl_download_uri = selected.jsonl_download_uri.replaceAll("default-cards", "oracle-cards");
    if (change === "size") selected.compressed_size = 96 * 1024 * 1024 + 1;
    expect(() => scryfallBulkPin(new TextEncoder().encode(JSON.stringify(document)))).toThrow();
  },
);

test("captured archive length and timestamp must agree with retained discovery identity", () => {
  const pin = {
    url: "https://data.scryfall.io/default-cards/default-cards-20260914090527.jsonl.gz",
    requestId: `scryfall-magic-en:listing:bulk-20260914090527-78247919:${"a".repeat(64)}`,
    compressedBytes: 78247919,
  };
  expect(scryfallCapturedBulkPin(pin)).toMatchObject({ cutoff: "2026-09-14", limits: { compressedBytes: 78247919 } });
  expect(() => scryfallCapturedBulkPin({ ...pin, compressedBytes: 78247918 })).toThrow();
  expect(() => scryfallCapturedBulkPin({ ...pin, requestId: "unattributed-archive" })).toThrow();
  expect(() => scryfallCapturedBulkPin({ ...pin, url: pin.url.replace("20260914", "20260915") })).toThrow();
});

test("the declared bulk filter retains incidental exclusions without converting them into Cards", () => {
  const adapter = requiredSourceAdapter("scryfall-magic-en@1");
  const bytes = readFileSync(new URL("../bulk/front_card.json", fixture));
  const source = JSON.parse(bytes.toString());
  expect(adapter.archiveExtraction!.record(bytes, "2026-09-14")).toEqual({
    sourceKey: source.id,
    exclusion: "incidental_deck_indicator",
    observations: [],
    requests: [],
  });
});
