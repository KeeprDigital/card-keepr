import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { riftboundOriginsErrata, riftboundOriginsErrataUrl } from "../../src/catalogue/adapters/riftbound-errata";
import { parseReconciliationObservation } from "../../src/catalogue/reconciliation/reconciliation-observation";
import { sourceAdapterForCoverage } from "../../src/catalogue/adapters/source-adapters";
import { riftboundSourceAdapterRegistration } from "../../src/catalogue/adapters/riftbound-source-adapter";
import { AdapterParseFailure } from "../../src/catalogue/adapters/adapter-parse-failure";

const bytes = readFileSync("acceptance/fixtures/real-sources/2026-09-06/raw/riftbound-errata.body");
test("malformed article decoding remains a source-contract failure", () => {
  for (const bytes of [
    new Uint8Array([0xff]),
    new TextEncoder().encode('<script id="__NEXT_DATA__">{</script>'),
    new TextEncoder().encode('<script id="__NEXT_DATA__">{"props":{"pageProps":{"page":{"blades":[null]}}}}</script>'),
  ])
    expect(() => riftboundOriginsErrata(bytes, riftboundOriginsErrataUrl)).toThrow(AdapterParseFailure);
});
test("Origins preserves the evidenced Dark Child heading alias without creating a second Card", () => {
  const observation = riftboundOriginsErrata(bytes, riftboundOriginsErrataUrl).find(
    (o) => o.source.heading === "Dark Child, Starter",
  )!;
  expect(observation.target.official_identity).toEqual({ kind: "publisher_name", value: "Dark Child - Starter" });
  expect(observation.observed_printed_rules_text).toBe("At the end of your turn, ready 2 runes.");
  const records = Array.from(
    { length: 6 },
    (_, page) =>
      JSON.parse(
        readFileSync(`acceptance/fixtures/real-sources/2026-09-08-riftbound/raw/cards-${page * 200}.json`, "utf8"),
      ).data,
  ).flat();
  const matching = records.filter((r) => r.name === observation.target.official_identity.value);
  expect(matching).toHaveLength(1);
  expect(matching[0].id).toBe("ogs-017-024");
  expect(parseReconciliationObservation("dark-child-alias", observation).kind).toBe("official_erratum");
  expect(() =>
    parseReconciliationObservation("forged-alias", {
      ...observation,
      observed_printed_rules_text: "Different old text",
    }),
  ).toThrow();
});
test("Origins retains all named corrections with article heading provenance", () => {
  expect(sourceAdapterForCoverage(riftboundSourceAdapterRegistration, "origins-errata").reconciliationCapability).toBe(
    "errata",
  );
  expect(sourceAdapterForCoverage(riftboundSourceAdapterRegistration, "origins-errata").reconciliationAreas).toEqual([
    "errata",
  ]);
  const observations = riftboundOriginsErrata(bytes, riftboundOriginsErrataUrl);
  expect(observations).toHaveLength(31);
  const monk = observations.find((o) => o.source.heading === "Kinkou Monk")!;
  expect(monk.observed_printed_rules_text).toContain("buff two other friendly units");
  expect(monk.corrected_rules_text).toContain("buff up to two other friendly units");
  expect(monk.source).toEqual({ kind: "article_heading", url: riftboundOriginsErrataUrl, heading: "Kinkou Monk" });
  expect(monk.published_on).toBe("2025-10-28");
  expect(monk.effective_from).toBeNull();
  for (const [index, observation] of observations.entries()) {
    expect(parseReconciliationObservation(`observation-${index}`, observation).kind).toBe("official_erratum");
  }
});

test("named Errata cannot forge article provenance or weaken the Bandai provenance contract", () => {
  const monk = riftboundOriginsErrata(bytes, riftboundOriginsErrataUrl).find(
    (o) => o.source.heading === "Kinkou Monk",
  )!;
  for (const source of [
    { ...monk.source, url: "https://example.com/errata" },
    { ...monk.source, url: `${riftboundOriginsErrataUrl}#invented` },
    { ...monk.source, heading: "Different Card" },
    { ...monk.source, image_url: "https://example.com/fabricated.png" },
  ])
    expect(() => parseReconciliationObservation("invalid", { ...monk, source })).toThrow();
  expect(() =>
    parseReconciliationObservation("invalid", {
      ...monk,
      game: "one-piece",
      target: { type: "card", official_identity: { kind: "card_number", value: "OP01-001" } },
    }),
  ).toThrow();
  expect(() => riftboundOriginsErrata(bytes, `${riftboundOriginsErrataUrl}?other=1`)).toThrow();
});
