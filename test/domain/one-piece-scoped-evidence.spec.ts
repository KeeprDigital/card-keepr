import { onePieceAdapter } from "../../src/catalogue/adapters/one-piece-adapter";
import { AdapterParseFailure } from "../../src/catalogue/adapters/adapter-parse-failure";
import { URL } from "node:url";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { limitlessOnePieceSourceAdapterRegistration as adapter } from "../../src/catalogue/adapters/limitless-one-piece-source-adapter";
import { checkedPrintingLineages } from "../../src/catalogue/reconciliation/scoped-disappearance";
import type { CatalogueCard, CataloguePrinting } from "../../src/catalogue/shared";

const html = readFileSync(
  new URL("../../acceptance/fixtures/real-sources/2026-09-06/raw/limitless-p001.body", import.meta.url),
  "utf8",
);
const parse = async (value: string) =>
  (
    await adapter.parseBytes!(new TextEncoder().encode(value), {
      mediaType: "text/html",
      url: "https://onepiece.limitlesstcg.com/cards/en/P-001",
    })
  )[0] as {
    source_sidecar: { raw: { optional_fields: unknown[] }; unmapped_optional_fields: unknown[] };
    [key: string]: unknown;
  };

test.each(['<span data-tooltip="Type">', '<span class="reminder-text">'])(
  "Limitless retains an unfamiliar labelled field at %s without changing canonical facts",
  async (marker) => {
    const original = await parse(html);
    const changed = await parse(
      html.replace(marker, `<span data-tooltip="Illustrator">Example Artist</span>${marker}`),
    );
    expect(changed.source_sidecar.raw.optional_fields).toEqual([{ label: "Illustrator", value: "Example Artist" }]);
    expect(changed.source_sidecar.unmapped_optional_fields).toEqual([
      {
        path: "source_sidecar.raw.optional_fields[0]",
        value: { label: "Illustrator", value: "Example Artist" },
      },
    ]);
    const { source_sidecar: _before, ...beforeFacts } = original;
    const { source_sidecar: _after, ...afterFacts } = changed;
    expect(afterFacts).toEqual(beforeFacts);
  },
);

test("named absence scope excludes other Card identities and unselected source lineages", () => {
  const card: CatalogueCard = {
    id: "card",
    game: "one-piece",
    official_identity: { kind: "card_number", value: "P-001" },
    name: "Luffy",
    effective_rules_text: null,
    game_data: { profile: "one-piece@1", attributes: {} },
  };
  const printing: CataloguePrinting = {
    id: "printing",
    card_id: card.id,
    rarity: { raw: null, normalized: null },
    printed_rules_text: null,
    game_data: null,
    locator_evidence: [
      { source_lineage: "one-piece-en", locator: "P-001_p6", variant_key: null, source_observation_id: "prior" },
    ],
  };
  const scopes = [
    {
      sourceLineage: "one-piece-en",
      supportedGame: "one-piece",
      cardIdentities: [{ kind: "card_number", value: "P-001" }],
    },
  ];
  expect(checkedPrintingLineages(card, printing, scopes)).toEqual(["one-piece-en"]);
  expect(
    checkedPrintingLineages({ ...card, official_identity: { kind: "card_number", value: "P-002" } }, printing, scopes),
  ).toEqual([]);
  expect(
    checkedPrintingLineages(
      card,
      {
        ...printing,
        locator_evidence: [{ ...printing.locator_evidence![0]!, source_lineage: "limitless-one-piece-en" }],
      },
      scopes,
    ),
  ).toEqual([]);
  expect(checkedPrintingLineages(card, printing, [])).toEqual([]);
});

test("a structurally complete Bandai six-record scope can report a disappeared seventh Printing", () => {
  const original = readFileSync(
    new URL("../../acceptance/fixtures/real-sources/2026-09-06/raw/bandai-p001.body", import.meta.url),
    "utf8",
  );
  const reduced = original
    .replace(/<dl class="modalCol" id="P-001_p6">[\s\S]*?<\/dl>/u, "")
    .replace('<div class="countCol">7 results</div>', '<div class="countCol">6 results</div>');
  const context = {
    url: "https://en.onepiece-cardgame.com/cardlist/?freewords=P-001",
    mediaType: "text/html",
    requestId: "one-piece-en:p-001-catalogue",
  };
  expect(onePieceAdapter.parse(context, new TextEncoder().encode(original))).toHaveLength(7);
  expect(onePieceAdapter.parse(context, new TextEncoder().encode(reduced))).toHaveLength(6);
});

for (const url of [
  "https://en.onepiece-cardgame.com/cardlist/?freewords=P-001",
  "https://en.onepiece-cardgame.com/events/2023/championship/store_championship_wave1.php",
])
  test(`Bandai named coverage classifies invalid UTF-8 at ${url}`, () => {
    expect(() => onePieceAdapter.parse({ url, mediaType: "text/html" }, new Uint8Array([0xff]))).toThrow(
      AdapterParseFailure,
    );
    expect(() => onePieceAdapter.discoverRequests(new Uint8Array([0xff]), { url, mediaType: "text/html" })).toThrow(
      AdapterParseFailure,
    );
  });
