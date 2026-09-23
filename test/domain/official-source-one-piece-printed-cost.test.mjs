import { test } from "vitest";
import assert from "node:assert/strict";
import { requiredSourceAdapter } from "../../src/catalogue/adapters/source-adapters.ts";
import { parseReconciliationObservation } from "../../src/catalogue/reconciliation/reconciliation-observation.ts";
import { retainedOfficialSourceFixture, retainedRestructuredParse } from "./official-source-raw-contract-shared.mjs";

// Bandai's card list omits a value by printing "-", the same placeholder it
// prints for an inapplicable Power, Counter or Attribute. The owner confirmed
// from the printed cards that the 23 Cards listed that way cost 0
// (issue #334). The printed token stays retained review evidence.
const seriesPage = "one-piece-en-card-list-op16-series";
const context = {
  url: "https://en.onepiece-cardgame.com/cardlist/?series=569116",
  requestId: "one-piece-en:card-list",
};
const omittedCostPath = "source_sidecar.raw.official_surfaces[0].document.printed_cost_omitted:OP16-020";

function retainedSeriesObservations() {
  const adapter = requiredSourceAdapter("one-piece-en@6");
  return retainedRestructuredParse(adapter, seriesPage, context).observations;
}

test("a retained Event Card whose printed cost Bandai omitted records cost 0", () => {
  const observations = retainedSeriesObservations();
  const event = observations.find(({ card }) => card?.official_identity.value === "OP16-020");
  assert.ok(event, "the retained OP16 series page carries the omitted-cost Event Card");
  assert.equal(event.card.game_data.attributes.card_type, "event");
  assert.equal(event.card.game_data.attributes.cost, 0);
  // The Publisher's other inapplicable fields keep their absent meaning.
  assert.equal(event.card.game_data.attributes.power, null);
  assert.equal(event.card.game_data.attributes.counter, null);
  assert.deepEqual(event.card.game_data.attributes.battle_attributes, []);
});

test("the omitted printed cost stays retained, unconsumed review evidence", () => {
  const [first] = retainedSeriesObservations();
  assert.deepEqual(
    first.source_sidecar.unmapped_optional_fields.filter(({ path }) => path.includes(".printed_cost_omitted:")),
    [{ path: omittedCostPath, value: "-" }],
  );
  assert.ok(
    !first.source_sidecar.consumed_fields.includes(omittedCostPath),
    "an omitted printed cost is not reported as a consumed Source field",
  );
});

test("reconciliation raises a precise review warning for the normalised cost", () => {
  const [first] = retainedSeriesObservations();
  const parsed = parseReconciliationObservation("srcobs_op16_series", first);
  const warnings = parsed.sourceWarnings.filter(({ code }) => code === "printed_cost_omitted_normalized");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].path, omittedCostPath);
  assert.equal(warnings[0].raw_value, "-");
  assert.equal(
    parsed.sourceWarnings.some(
      ({ code, path }) => code === "unknown_source_field" && path.includes("printed_cost_omitted"),
    ),
    false,
  );
});

test("every retained Card on the page satisfies the Game Profile it is published through", () => {
  const observations = retainedSeriesObservations();
  const costs = new Map(
    observations.map((observation, index) => {
      const parsed = parseReconciliationObservation(`srcobs_op16_${index}`, observation);
      const card = parsed.observedCardAndPrinting.card;
      return [card.official_identity.value, card.game_data.attributes];
    }),
  );
  // 155 retained appearances resolve to 125 distinct printed Card numbers.
  assert.equal(observations.length, 155);
  assert.equal(costs.size, 125);
  // The candidate that blocked the full English scope failed here: "A One
  // Piece Character, Event, or Stage requires non-negative cost."
  assert.equal(costs.get("OP16-020").cost, 0);
  // A Leader has no printed cost at all and keeps its absent value.
  assert.equal(costs.get("OP16-001").card_type, "leader");
  assert.equal(costs.get("OP16-001").cost, null);
  assert.equal(costs.get("OP16-001").life, 5);
  // An ordinary Event keeps the cost the Publisher prints.
  assert.equal(costs.get("OP16-019").cost, 9);
});

test("a Leader whose printed cost is absent raises no normalisation warning", () => {
  const observations = retainedSeriesObservations();
  const leader = observations.find(({ card }) => card?.official_identity.value === "OP16-001");
  assert.ok(leader);
  assert.deepEqual(
    observations.flatMap(({ source_sidecar }) =>
      (source_sidecar.unmapped_optional_fields ?? []).filter(({ path }) => path.includes(".printed_cost_omitted:")),
    ),
    [{ path: omittedCostPath, value: "-" }],
    "only the one omitted Event cost on this page is normalised",
  );
});

test("a Card type that requires a cost still fails closed when the field is absent", () => {
  const adapter = requiredSourceAdapter("one-piece-en@6");
  const { bytes, metadata } = retainedOfficialSourceFixture(seriesPage);
  // Remove the printed Cost block from the omitted-cost Event: an entirely
  // missing field remains unmodelled drift rather than a normalised 0.
  const html = bytes
    .toString("utf8")
    .replace(
      /(<dl class="modalCol" id="OP16-020">[\s\S]*?)<div class="cost"><h3>Cost<\/h3>-<\/div>/u,
      '$1<div class="cost"></div>',
    );
  assert.notEqual(html, bytes.toString("utf8"));
  assert.throws(
    () =>
      adapter.parseBytes(new TextEncoder().encode(html), {
        mediaType: metadata.content_type,
        ...context,
      }),
    /One Piece event cost must be non-null/u,
  );
});
