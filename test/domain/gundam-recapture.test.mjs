import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { expect, test } from "vitest";
import { requiredSourceAdapter } from "../../src/catalogue/adapters/source-adapters";

const adapter = requiredSourceAdapter("gundam-en-asia@7");
function retained(name) {
  const capture = JSON.parse(
    gunzipSync(
      readFileSync(
        new URL(
          `../../acceptance/fixtures/retained-official-source/history/2026-09-09/${name}.json.gz`,
          import.meta.url,
        ),
      ),
    ),
  );
  const bytes = Buffer.from(capture.body_base64, "base64");
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(capture.full_body_sha256);
  expect(bytes.length).toBe(capture.full_body_size);
  return { bytes, context: { url: capture.source_url, mediaType: capture.content_type } };
}

test("complete Gundam Card listings do not reschedule the registered Products root as a Product detail", () => {
  const listing = retained("gundam-complete-listing");
  const context = { ...listing.context, requestId: `gundam-en-asia:listing:${"0".repeat(64)}` };
  const requests = adapter.discoverRequests(listing.bytes, context);
  expect(
    requests.some(
      ({ role, url }) => role === "product_detail" && url === "https://www.gundam-gcg.com/asia-en/products/list.php",
    ),
  ).toBe(false);
  expect(requests.some(({ role }) => role === "image")).toBe(true);
  const products = retained("gundam-products-root");
  expect(() =>
    adapter.parseBytes(products.bytes, { ...products.context, requestId: "gundam-en-asia:products" }),
  ).not.toThrow();
  expect(() =>
    adapter.parseBytes(products.bytes, {
      ...products.context,
      requestId: `gundam-en-asia:product_detail:${"0".repeat(64)}`,
    }),
  ).toThrow("Product detail heading does not match its official title");
  expect(
    adapter
      .discoverRequests(products.bytes, { ...products.context, requestId: "gundam-en-asia:products" })
      .some(({ role, url }) => role === "product_detail" && url.includes("/gd05.html")),
  ).toBe(true);
});
