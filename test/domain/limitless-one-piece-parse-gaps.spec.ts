import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { URL } from "node:url";
import { expect, test } from "vitest";
import { limitlessOnePieceSourceAdapterRegistration as adapter } from "../../src/catalogue/adapters/limitless-one-piece-source-adapter";

// Two retained-byte parser gaps the owner ruled on (issue #334): Limitless
// renders an inline "[Trigger]" reference with the same markup as a real
// Trigger section, and it publishes an unresolved translation key for one
// Attribute. Both produced Card facts that disagreed with Bandai's.
const pack = new URL("../../acceptance/fixtures/real-sources/2026-09-22-limitless-parse-gaps/", import.meta.url);
const pilot = new URL("../../acceptance/fixtures/real-sources/2026-09-15-limitless/raw/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", pack), "utf8")) as {
  captures: { request: { url: string }; body: string; bytes: number; sha256: string }[];
};

function retained(number: string) {
  const capture = manifest.captures.find(({ request }) => request.url.endsWith(`/${number}`));
  if (capture === undefined) throw new Error(`no retained capture for ${number}`);
  const bytes = readFileSync(new URL(capture.body, pack));
  expect(bytes.length).toBe(capture.bytes);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(capture.sha256);
  return bytes;
}

async function parse(bytes: Uint8Array, url: string) {
  const observations = await adapter.parseBytes!(bytes, {
    mediaType: "text/html",
    url,
    requestId: `limitless-one-piece-en:detail:${"0".repeat(64)}`,
  });
  type ObservedCard = {
    card: { game_data: { attributes: Record<string, unknown> }; effective_rules_text: string | null };
  };
  const card = (observations as ObservedCard[]).find((observation) => "card" in observation)!;
  expect(card).toBeDefined();
  return card;
}

test("an inline [Trigger] reference stays inside the rules text", async () => {
  const card = await parse(retained("OP17-109"), "https://onepiece.limitlesstcg.com/cards/OP17-109");
  // Bandai, the card-facts authority, prints exactly this sentence.
  expect(card.card.effective_rules_text).toBe(
    "[On Play] You may trash 1 card with a [Trigger] from your hand: Draw 3 cards.",
  );
  expect(card.card.game_data.attributes.trigger_text).toBeNull();
});

test("a source page truncated after an inline [Trigger] is not split into a Trigger", async () => {
  const card = await parse(retained("OP17-105"), "https://onepiece.limitlesstcg.com/cards/OP17-105");
  // The retained page itself stops mid-sentence; the parser must not invent a
  // Trigger from the remainder. Bandai supplies the complete text.
  expect(card.card.effective_rules_text).toBe(
    "[On Play] You may trash 1 card with a [Trigger] from your hand: Return up to 1 of your opponent's Characters with a",
  );
  expect(card.card.game_data.attributes.trigger_text).toBeNull();
});

test("a real Trigger section is still read as a Trigger", async () => {
  const bytes = readFileSync(new URL("limitless-op16-019.body", pilot));
  const card = await parse(bytes, "https://onepiece.limitlesstcg.com/cards/OP16-019");
  expect(card.card.effective_rules_text).toBe(
    '[Main] Play up to 2 Character cards with a type including "Whitebeard Pirates" and 8000 power from your hand.',
  );
  expect(card.card.game_data.attributes.trigger_text).toBe("[Trigger] Your Leader gains +1000 power during this turn.");
});

test("an unresolved translation key is recorded as a field the page does not state", async () => {
  const card = await parse(retained("OP13-079"), "https://onepiece.limitlesstcg.com/cards/OP13-079");
  // Bandai prints "?" for this Leader; Limitless publishes "card.attribute.?",
  // which is not a source fact and must not reach the catalogue.
  expect(card.card.game_data.attributes.battle_attributes).toEqual([]);
  expect(JSON.stringify(card.card.game_data.attributes)).not.toContain("card.attribute");
});
