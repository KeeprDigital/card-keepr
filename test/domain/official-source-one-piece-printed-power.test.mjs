import { test } from "vitest";
import assert from "node:assert/strict";
import { requiredSourceAdapter } from "../../src/catalogue/adapters/source-adapters.ts";
import { parseReconciliationObservation } from "../../src/catalogue/reconciliation/reconciliation-observation.ts";
import { retainedRestructuredParse } from "./official-source-raw-contract-shared.mjs";

// A Character carries a printed power, and Bandai omits a printed 0 with the
// same "-" placeholder it uses for cost. The owner confirmed this from the
// printed OP16-034 (issue #334); Limitless independently publishes 0 for the
// same 152 Cards. An Event or Stage prints no power at all, so its "-" stays
// absent and neither source states a value.
const seriesPage = "one-piece-en-card-list-op16-series";
const context = {
  url: "https://en.onepiece-cardgame.com/cardlist/?series=569116",
  requestId: "one-piece-en:card-list",
};
const omittedPowerPath = "source_sidecar.raw.official_surfaces[0].document.printed_power_omitted:OP16-034";

function retained() {
  return retainedRestructuredParse(requiredSourceAdapter("one-piece-en@6"), seriesPage, context).observations;
}

function byNumber(observations, number) {
  return observations.find(({ card }) => card?.official_identity.value === number);
}

test("a Character whose printed power Bandai omitted records power 0", () => {
  const character = byNumber(retained(), "OP16-034");
  assert.ok(character, "the retained OP16 series page carries the omitted-power Character");
  assert.equal(character.card.game_data.attributes.card_type, "character");
  assert.equal(character.card.game_data.attributes.power, 0);
  // Its other printed facts are untouched.
  assert.equal(character.card.game_data.attributes.cost, 1);
  assert.equal(character.card.game_data.attributes.counter, 1000);
  assert.deepEqual(character.card.game_data.attributes.battle_attributes, ["strike"]);
});

test("an Event and a Stage keep an absent power", () => {
  const observations = retained();
  const event = byNumber(observations, "OP16-020");
  const stage = byNumber(observations, "OP16-021");
  assert.ok(event && stage);
  assert.equal(event.card.game_data.attributes.card_type, "event");
  assert.equal(event.card.game_data.attributes.power, null);
  assert.equal(stage.card.game_data.attributes.card_type, "stage");
  assert.equal(stage.card.game_data.attributes.power, null);
});

test("a Character with a printed power is unchanged", () => {
  const character = byNumber(retained(), "OP16-004");
  assert.ok(character);
  assert.equal(character.card.game_data.attributes.power, 8000);
});

test("the omitted printed power stays retained, unconsumed review evidence", () => {
  const [first] = retained();
  const omitted = first.source_sidecar.unmapped_optional_fields.filter(({ path }) =>
    path.includes(".printed_power_omitted:"),
  );
  assert.ok(omitted.length > 0);
  assert.deepEqual(new Set(omitted.map(({ value }) => value)), new Set(["-"]));
  assert.ok(omitted.some(({ path }) => path === omittedPowerPath));
  assert.ok(
    !first.source_sidecar.consumed_fields.includes(omittedPowerPath),
    "an omitted printed power is not reported as a consumed Source field",
  );
});

test("reconciliation raises a precise review warning for the normalised power", () => {
  const [first] = retained();
  const parsed = parseReconciliationObservation("srcobs_op16_power", first);
  const warnings = parsed.sourceWarnings.filter(({ code }) => code === "printed_power_omitted_normalized");
  assert.ok(warnings.length > 0);
  assert.deepEqual(new Set(warnings.map(({ raw_value }) => raw_value)), new Set(["-"]));
  assert.equal(
    parsed.sourceWarnings.some(
      ({ code, path }) => code === "unknown_source_field" && path.includes("printed_power_omitted"),
    ),
    false,
  );
});

test("every retained Card still satisfies the Game Profile", () => {
  const observations = retained();
  for (const [index, observation] of observations.entries()) {
    const parsed = parseReconciliationObservation(`srcobs_power_${index}`, observation);
    const attributes = parsed.observedCardAndPrinting.card.game_data.attributes;
    if (["event", "stage"].includes(attributes.card_type)) assert.equal(attributes.power, null);
    else assert.equal(typeof attributes.power, "number");
  }
});
