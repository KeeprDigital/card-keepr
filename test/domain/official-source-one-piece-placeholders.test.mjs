import { test } from "vitest";
import assert from "node:assert/strict";
import { requiredSourceAdapter } from "../../src/catalogue/adapters/source-adapters.ts";
import { parseReconciliationObservation } from "../../src/catalogue/reconciliation/reconciliation-observation.ts";
import { retainedRestructuredParse } from "./official-source-raw-contract-shared.mjs";

// Bandai prints "-" in the Effect box for a Card with no ability, the same
// placeholder it prints for an inapplicable Power, Counter or Attribute. The
// owner ruled that this is the absence of rules text, not the text "-"
// (issue #334); 325 Cards of the full English scope would otherwise publish
// with the single character "-" as their rules text.
const seriesPage = "one-piece-en-card-list-op16-series";
const context = {
  url: "https://en.onepiece-cardgame.com/cardlist/?series=569116",
  requestId: "one-piece-en:card-list",
};
const omittedEffectPath = "source_sidecar.raw.official_surfaces[0].document.printed_effect_omitted:OP16-004";

function retained() {
  return retainedRestructuredParse(requiredSourceAdapter("one-piece-en@6"), seriesPage, context).observations;
}

test("a retained Card whose Effect box Bandai printed as '-' publishes with no rules text", () => {
  const observations = retained();
  const vanilla = observations.find(({ card }) => card?.official_identity.value === "OP16-004");
  assert.ok(vanilla, "the retained OP16 series page carries the placeholder-Effect Card");
  assert.equal(vanilla.card.game_data.attributes.effect_text, null);
  assert.equal(vanilla.card.effective_rules_text, null);
  assert.equal(vanilla.printing.printed_rules_text, null);
  // The Card keeps every other printed fact.
  assert.equal(vanilla.card.game_data.attributes.card_type, "character");
  assert.equal(vanilla.card.game_data.attributes.cost, 7);
  assert.equal(vanilla.card.game_data.attributes.power, 8000);
});

test("the placeholder Effect stays retained, unconsumed review evidence", () => {
  const [first] = retained();
  const omitted = first.source_sidecar.unmapped_optional_fields.filter(({ path }) =>
    path.includes(".printed_effect_omitted:"),
  );
  assert.ok(omitted.length > 0, "the omitted Effect token is retained");
  assert.deepEqual(new Set(omitted.map(({ value }) => value)), new Set(["-"]));
  assert.ok(omitted.some(({ path }) => path === omittedEffectPath));
  assert.ok(
    !first.source_sidecar.consumed_fields.includes(omittedEffectPath),
    "a placeholder Effect is not reported as a consumed Source field",
  );
});

test("reconciliation raises a precise review warning for the placeholder Effect", () => {
  const [first] = retained();
  const parsed = parseReconciliationObservation("srcobs_op16_effects", first);
  const warnings = parsed.sourceWarnings.filter(({ code }) => code === "printed_effect_omitted_normalized");
  assert.ok(warnings.length > 0);
  assert.deepEqual(new Set(warnings.map(({ raw_value }) => raw_value)), new Set(["-"]));
  assert.equal(
    parsed.sourceWarnings.some(
      ({ code, path }) => code === "unknown_source_field" && path.includes("printed_effect_omitted"),
    ),
    false,
  );
});

test("a Card with real rules text is untouched", () => {
  const observations = retained();
  const event = observations.find(({ card }) => card?.official_identity.value === "OP16-019");
  assert.ok(event);
  assert.match(event.card.effective_rules_text, /^\[Main\] Play up to 2 Character cards/u);
  assert.equal(
    event.card.game_data.attributes.trigger_text,
    "[Trigger] Your Leader gains +1000 power during this turn.",
  );
  // No Card on this page retains the placeholder as text.
  assert.equal(
    observations.some(({ card }) => card?.effective_rules_text === "-"),
    false,
  );
  assert.equal(
    observations.some(({ printing }) => printing?.printed_rules_text === "-"),
    false,
  );
});
