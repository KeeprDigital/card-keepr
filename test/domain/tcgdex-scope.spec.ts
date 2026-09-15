import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { expect, test } from "vitest";
import { tcgdexScopeInventory } from "../../src/catalogue/adapters/tcgdex-scope";

const fixture = new URL("../../acceptance/fixtures/real-sources/2026-09-15-pokemon-scope/raw/", import.meta.url);
const bytes = (name: string) => readFileSync(new URL(name, fixture));

test("the retained English inventory preserves exact candidate IDs and excludes the observed Pocket membership", () => {
  const scope = tcgdexScopeInventory(bytes("english-sets.body"), bytes("pocket-series.body"), "2026-09-15");
  expect(scope.sets).toHaveLength(203);
  expect(scope.excludedPocket).toHaveLength(15);
  expect(scope.sourceReportedRecords).toBe(21_296);
  expect(scope.sets.find((set) => set.id === "tk-ex-latia")).toMatchObject({
    id: "tk-ex-latia",
    sourceReportedRecords: 10,
    url: "https://api.tcgdex.net/v2/en/sets/tk-ex-latia",
  });
  expect(scope.sets.some((set) => set.id === "A1")).toBe(false);
  expect(scope.issuedCutoff).toBe("2026-09-15");
});

test("duplicate or missing Pocket memberships and count drift cannot silently change the candidate scope", () => {
  const sets = JSON.parse(bytes("english-sets.body").toString());
  const pocket = JSON.parse(bytes("pocket-series.body").toString());
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  for (const [inventory, series] of [
    [[...sets, sets[0]], pocket],
    [sets, { ...pocket, sets: [...pocket.sets, pocket.sets[0]] }],
    [sets.filter((set: { id: string }) => set.id !== pocket.sets[0].id), pocket],
    [sets, { ...pocket, sets: [{ ...pocket.sets[0], cardCount: { total: 1, official: 1 } }, ...pocket.sets.slice(1)] }],
  ])
    expect(() => tcgdexScopeInventory(encode(inventory), encode(series), "2026-09-15")).toThrow();
});

test("set details retain evidenced set/local boundaries rather than splitting opaque IDs", () => {
  const scope = tcgdexScopeInventory(bytes("english-sets.body"), bytes("pocket-series.body"), "2026-09-15");
  const set = scope.qualifySet(bytes("set-tk-ex-latia.body"), "https://api.tcgdex.net/v2/en/sets/tk-ex-latia");
  expect(set).toMatchObject({
    id: "tk-ex-latia",
    seriesId: "tk",
    releaseDate: "2004-07-01",
    eligibility: "issued_set_candidate",
    cards: expect.arrayContaining([
      { id: "tk-ex-latia-8", localId: "8", url: "https://api.tcgdex.net/v2/en/cards/tk-ex-latia-8" },
    ]),
  });
  expect(set.cards).toHaveLength(10);
});

test("set closure rejects missing, repeated and cross-set records while retaining leading-zero local IDs", () => {
  const scope = tcgdexScopeInventory(bytes("english-sets.body"), bytes("pocket-series.body"), "2026-09-15");
  const detail = JSON.parse(bytes("set-swsh9.body").toString());
  const url = "https://api.tcgdex.net/v2/en/sets/swsh9";
  expect(scope.qualifySet(bytes("set-swsh9.body"), url).cards).toContainEqual({
    id: "swsh9-053",
    localId: "053",
    url: "https://api.tcgdex.net/v2/en/cards/swsh9-053",
  });
  for (const cards of [
    detail.cards.slice(1),
    [detail.cards[0], ...detail.cards.slice(0, -1)],
    [{ ...detail.cards[0], id: "base1-1" }, ...detail.cards.slice(1)],
  ])
    expect(() => scope.qualifySet(new TextEncoder().encode(JSON.stringify({ ...detail, cards })), url)).toThrow();
  const drift = { ...detail, cardCount: { ...detail.cardCount, official: 999 } };
  expect(() => scope.qualifySet(new TextEncoder().encode(JSON.stringify(drift)), url)).toThrow();
});

test("a source membership alone does not establish physical classification or issuance at the recorded cutoff", () => {
  const scope = tcgdexScopeInventory(bytes("english-sets.body"), bytes("pocket-series.body"), "2026-09-15");
  const detail = JSON.parse(bytes("set-swsh9.body").toString());
  const qualify = (value: unknown) =>
    scope.qualifySet(new TextEncoder().encode(JSON.stringify(value)), "https://api.tcgdex.net/v2/en/sets/swsh9");
  expect(qualify({ ...detail, releaseDate: "2026-09-16" })).toMatchObject({
    eligibility: "not_yet_issued",
    releaseDate: "2026-09-16",
  });
  for (const releaseDate of [undefined, "", "2026-02-30"])
    expect(qualify({ ...detail, releaseDate })).toMatchObject({
      eligibility: "unresolved",
      reason: "unresolved_release_date",
    });
  for (const id of ["tcgp", "unfamiliar-digital-series"])
    expect(qualify({ ...detail, serie: { id } })).toMatchObject({
      eligibility: "unresolved",
      reason: "unresolved_series",
    });
});

test("the source's official-count floor preserves six named coverage gaps without inventing missing Card IDs", () => {
  const scope = tcgdexScopeInventory(bytes("english-sets.body"), bytes("pocket-series.body"), "2026-09-15");
  for (const [id, official, enumerated] of [
    ["wp", 7, 0],
    ["jumbo", 160, 0],
    ["sp", 10, 0],
    ["rc", 25, 0],
    ["tk-sm-l", 30, 18],
    ["mfb", 48, 34],
  ] as const) {
    const detail = scope.qualifySet(bytes(`set-${id}.body`), `https://api.tcgdex.net/v2/en/sets/${id}`);
    expect(detail.cards).toHaveLength(enumerated);
    expect(detail.sourceCountGap).toEqual({
      officialCount: official,
      reportedTotal: official,
      enumeratedRecords: enumerated,
    });
  }
});
