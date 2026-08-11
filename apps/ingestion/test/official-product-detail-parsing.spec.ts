import { expect, test } from "vitest";
import { requiredSourceAdapter } from "../../../src/catalogue/source-adapters";

const productDetailRequestId = `gundam-en-asia:product_detail:${"a".repeat(64)}`;

async function parseGundamProductDetail(
  html: string,
  url: string,
): Promise<unknown> {
  const adapter = requiredSourceAdapter("gundam-en-asia@6");
  const observations = await adapter.parseBytes!(
    new TextEncoder().encode(html),
    {
      mediaType: "text/html; charset=utf-8",
      url,
      requestId: productDetailRequestId,
    },
  );
  expect(observations).toHaveLength(1);
  return observations[0];
}

test("a live product detail without its exact publisher title suffix fails closed", async () => {
  await expect(
    parseGundamProductDetail(
      `<html><title>Freedom Ascension [GD05]</title>
        <h1>GUNDAM CARD GAME</h1>
        <h2 class="mvColTitle">Freedom Ascension [GD05]</h2>
      </html>`,
      "https://www.gundam-gcg.com/asia-en/products/gd05.html",
    ),
  ).rejects.toThrow(/Product detail is missing its official title/u);
});

test("a live accessory product detail is retained as explicit non-card evidence", async () => {
  const observation = await parseGundamProductDetail(
    `<html><title>Official Card Case Set 02 | GUNDAM CARD GAME Official Website</title>
      <h1>GUNDAM CARD GAME</h1>
      <h2 class="mvColTitle">Official Card Case Set 02</h2>
      <dl><dt>Release Date</dt><dd>2026.7.25</dd></dl>
    </html>`,
    "https://www.gundam-gcg.com/asia-en/products/deck-case02.html",
  );
  expect(observation).toMatchObject({
    product_release_catalogue: {
      products: [],
      distribution_contexts: [{
        key: "non-card:accessory:official card case set 02",
        kind: "other",
        label: "accessory",
        evidence_category: "explicit",
      }],
    },
  });
});
