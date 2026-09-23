import { test } from "vitest";
import assert from "node:assert/strict";
import {
  onePieceCardFactsAuthority,
  reconcileOnePieceCardAuthority,
} from "../../src/catalogue/reconciliation/one-piece-reconciliation.ts";

// Bandai is the designated card-facts authority and Limitless is supplementary,
// but nothing told reconciliation so: 787 Cards of the full English scope
// disagreed and blocked the candidate. The owner ruled that Bandai wins every
// Card-level field, that a base locator outranks a reprint, and that the losing
// value is recorded rather than published (issue #334).
const card = (overrides = {}) => ({
  game: "one-piece",
  category: "gameplay",
  gameplay_applicability: "applicable",
  name: "Charlotte Pudding",
  official_identity: { kind: "card_number", value: "OP17-109" },
  effective_rules_text: "[On Play] You may trash 1 card with a [Trigger] from your hand: Draw 3 cards.",
  game_data: { profile: "one-piece@1", attributes: { card_type: "character", power: 3000, block_icons: ["5"] } },
  related_cards: [],
  ...overrides,
});
const bandaiBase = { fromAuthority: true, isBaseRecord: true };
const bandaiReprint = { fromAuthority: true, isBaseRecord: false };
const limitless = { fromAuthority: false, isBaseRecord: true };

function authority(facts, standing) {
  return { card: facts, fromAuthority: standing.fromAuthority, hasBaseRecord: standing.isBaseRecord };
}

test("the designated authority is Bandai's lineage", () => {
  assert.equal(onePieceCardFactsAuthority, "one-piece-en");
});

test("agreeing observations record nothing", () => {
  const resolved = reconcileOnePieceCardAuthority(authority(card(), bandaiBase), card(), limitless);
  assert.equal(resolved.superseded, null);
  assert.deepEqual(resolved.authority.card, card());
});

test("a supplementary source never overwrites the authority, in either order", () => {
  const supplementary = card({ effective_rules_text: "[On Play] You may trash 1 card with a" });
  const authorityFirst = reconcileOnePieceCardAuthority(authority(card(), bandaiBase), supplementary, limitless);
  assert.equal(authorityFirst.authority.card.effective_rules_text, card().effective_rules_text);
  assert.equal(authorityFirst.superseded.reason, "supplementary_source");
  assert.equal(authorityFirst.superseded.material, true);
  assert.deepEqual(authorityFirst.superseded.fields, ["effective_rules_text"]);

  const supplementaryFirst = reconcileOnePieceCardAuthority(authority(supplementary, limitless), card(), bandaiBase);
  assert.equal(supplementaryFirst.authority.card.effective_rules_text, card().effective_rules_text);
  assert.equal(supplementaryFirst.superseded.reason, "supplementary_source");
});

test("a spacing-only disagreement is recorded as spacing, not wording", () => {
  // Limitless renders "[Mr.3 (Galdino) ]" where Bandai prints "[Mr.3(Galdino)]".
  const spaced = card({
    effective_rules_text: "[On Play] You may trash 1 card with a [Trigger] from your hand:  Draw 3 cards.",
  });
  const resolved = reconcileOnePieceCardAuthority(authority(card(), bandaiBase), spaced, limitless);
  assert.equal(resolved.superseded.material, false);
  assert.equal(resolved.authority.card.effective_rules_text, card().effective_rules_text);
});

test("a reprint does not overwrite the base locator's printed text", () => {
  // OP10-065 is reworded between printings; the base locator is published and
  // the reprint is flagged for review.
  const reworded = card({ effective_rules_text: "[Activate: Main] Rest 1 of your DON!! cards." });
  const resolved = reconcileOnePieceCardAuthority(authority(card(), bandaiBase), reworded, bandaiReprint);
  assert.equal(resolved.authority.card.effective_rules_text, card().effective_rules_text);
  assert.equal(resolved.superseded.reason, "reprint");
  assert.equal(resolved.superseded.material, true);

  const reprintFirst = reconcileOnePieceCardAuthority(authority(reworded, bandaiReprint), card(), bandaiBase);
  assert.equal(reprintFirst.authority.card.effective_rules_text, card().effective_rules_text);
  assert.equal(reprintFirst.superseded.reason, "reprint");
});

test("differing block icons between printings are recorded, never a Card conflict", () => {
  // The block number is the release block, so reprints legitimately differ.
  const later = card({
    game_data: { profile: "one-piece@1", attributes: { card_type: "character", power: 3000, block_icons: ["4"] } },
  });
  const resolved = reconcileOnePieceCardAuthority(authority(card(), bandaiBase), later, bandaiReprint);
  assert.deepEqual(resolved.superseded.fields, ["attributes.block_icons"]);
  assert.deepEqual(resolved.authority.card.game_data.attributes.block_icons, ["5"]);
});

test("two records of equal standing keep the first and say so", () => {
  const other = card({ name: "Charlotte Pudding (reprint)" });
  const resolved = reconcileOnePieceCardAuthority(authority(card(), bandaiBase), other, bandaiBase);
  assert.equal(resolved.superseded.reason, "equal_standing");
  assert.equal(resolved.authority.card.name, "Charlotte Pudding");
});

test("related cards are carried, not compared", () => {
  const withRelations = card({ related_cards: [{ kind: "shared_artwork", card_id: "card_x" }] });
  const resolved = reconcileOnePieceCardAuthority(authority(card(), bandaiBase), withRelations, bandaiBase);
  assert.equal(resolved.superseded, null);
});
