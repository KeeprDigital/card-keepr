import { expect, test } from "vitest";
import { requiredSourceAdapter } from "../../src/catalogue/adapters";

const productDetailRequestId = `gundam-en-asia:product_detail:${"a".repeat(64)}`;
const cardDetailRequestId = `fusion-world-en:detail:${"b".repeat(64)}`;

async function parseGundamProductDetail(html: string, url: string): Promise<unknown> {
  const adapter = requiredSourceAdapter("gundam-en-asia@7");
  const observations = await adapter.parseBytes!(new TextEncoder().encode(html), {
    mediaType: "text/html; charset=utf-8",
    url,
    requestId: productDetailRequestId,
  });
  expect(observations).toHaveLength(1);
  return observations[0];
}

async function parseFusionWorldCardDetail(html: string, locator: string): Promise<Record<string, unknown>> {
  const adapter = requiredSourceAdapter("fusion-world-en@9");
  const observations = await adapter.parseBytes!(new TextEncoder().encode(html), {
    mediaType: "text/html; charset=utf-8",
    url: `https://www.dbs-cardgame.com/fw/en/cardlist/detail.php?card_no=${locator}`,
    requestId: cardDetailRequestId,
  });
  expect(observations).toHaveLength(1);
  return observations[0] as Record<string, unknown>;
}

function fusionWorldCardDetailHtml({
  locator,
  name,
  cardType,
  rarity,
}: {
  locator: string;
  name: string;
  cardType: string;
  rarity: string | null;
}): string {
  const cell = (label: string, value: string) =>
    `<div class="cardDataCell"><h6>${label}</h6><div class="data">${value}</div></div>`;
  return `<html><body><main class="mainCol">
    <article class="article cardDetailPageCol"><div class="cardDetailPageContent">
      <div class="cardNoCol"><div class="cardNo">${locator}</div>${
        rarity === null ? "" : `<div class="rarity">${rarity}</div>`
      }</div>
      <div class="nameCol"><h1 class="cardName">${name}</h1></div>
      <div class="cardCol"><div class="cardImage">
        <img src="../../images/cards/card/en/${locator}.webp" alt="${locator}">
      </div></div>
      <div class="cardDataCol"><div class="cardData">
        <div class="cardDataRow">
          ${cell("Card type", cardType)}
          <div class="cardDataCell"><h6>Color</h6><div class="data color-">
            <div class="colValue" data-color="no-color">-</div>
          </div></div>
          ${cell("Cost", "-")}
          ${cell("Specified cost", "-")}
          ${cell("Power", "-")}
          ${cell("Combo power", "-")}
        </div>
        <div class="cardDataRow">${cell("Special Traits", "-")}</div>
        <div class="cardDataRow">${cell("Skills", "Official skill wording.")}</div>
        <div class="cardDataRow">
          ${cell("Where to get it", "STORY BOOSTER 01 [ST01]")}
        </div>
      </div></div>
    </div></article>
  </main></body></html>`;
}

test("a live Energy Marker card detail is retained without a published rarity", async () => {
  const observation = await parseFusionWorldCardDetail(
    fusionWorldCardDetailHtml({
      locator: "E-148",
      name: "Energy Marker",
      cardType: "ENERGY MARKER",
      rarity: null,
    }),
    "E-148",
  );
  expect(observation).toMatchObject({
    card: { game_data: { attributes: { card_type: "energy_marker" } } },
    identity_evidence: { locator: "E-148" },
    printing: { rarity: { raw: null, normalized: null } },
  });
});

test("a live non-Energy-Marker card detail without a rarity still fails closed", async () => {
  await expect(
    parseFusionWorldCardDetail(
      fusionWorldCardDetailHtml({
        locator: "FP-001",
        name: "Promotional Battle Card",
        cardType: "BATTLE",
        rarity: null,
      }),
      "FP-001",
    ),
  ).rejects.toThrow(/Fusion World Card detail is missing its rarity\./u);
});

test("a live Energy Marker card detail that publishes a rarity fails closed", async () => {
  await expect(
    parseFusionWorldCardDetail(
      fusionWorldCardDetailHtml({
        locator: "E-148",
        name: "Energy Marker",
        cardType: "ENERGY MARKER",
        rarity: "C",
      }),
      "E-148",
    ),
  ).rejects.toThrow(/Fusion World Energy Marker detail must not publish a rarity\./u);
});

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
      distribution_contexts: [
        {
          key: "non-card:accessory:official card case set 02",
          kind: "other",
          label: "accessory",
          evidence_category: "explicit",
        },
      ],
    },
  });
});
