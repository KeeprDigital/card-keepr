import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { URL } from "node:url";
import { expect, test } from "vitest";
import { sourceAdapterForCoverage } from "../../src/catalogue/adapters/source-adapters";
import { tcgdexPokemonSourceAdapterRegistration } from "../../src/catalogue/adapters/tcgdex-pokemon-source-adapter";
import { parseReconciliationObservation } from "../../src/catalogue/reconciliation/reconciliation-observation";
import type { SourceAdapterParent } from "../../src/catalogue/adapters/source-adapter-registration-types";

const directory = new URL("../../acceptance/fixtures/real-sources/2026-09-15-pokemon-scope/", import.meta.url);
const captures = JSON.parse(readFileSync(new URL("manifest.json", directory), "utf8")).captures as {
  id: string;
  url: string;
  finishedAt: string;
  sha256: string;
  body: string;
}[];
function parent(id: string, role: string): SourceAdapterParent {
  const capture = captures.find((value) => value.id === id)!;
  return {
    requestId: `request-${id}`,
    snapshotId: `snapshot-${id}`,
    role,
    url: capture.url,
    mediaType: "application/json",
    retrievedAt: capture.finishedAt,
    contentSha256: capture.sha256,
    bytes: readFileSync(new URL(capture.body, directory)),
  };
}

test("production declared Pokémon scope discovers exact retained roots and Set membership without catalogue records", async () => {
  const adapter = sourceAdapterForCoverage(tcgdexPokemonSourceAdapterRegistration, "english-declared-catalogue");
  const english = parent("english-sets", "surface");
  const pocket = parent("pocket-series", "listing");
  const set = parent("set-tk-ex-latia", "listing");
  expect(adapter.requiredSurfaces?.map((surface) => adapter.requestUrlForSurface!(surface))).toEqual([english.url]);
  const rootContext = { url: english.url, mediaType: english.mediaType, parents: [] };
  expect(await adapter.parseBytes!(english.bytes, rootContext)).toEqual([]);
  expect(adapter.discoverRequests!(english.bytes, rootContext)).toEqual([
    { role: "listing", url: pocket.url, headers: { accept: "application/json" } },
  ]);
  const pocketContext = { url: pocket.url, mediaType: pocket.mediaType, parents: [english] };
  expect(await adapter.parseBytes!(pocket.bytes, pocketContext)).toEqual([]);
  const sets = adapter.discoverRequests!(pocket.bytes, pocketContext);
  expect(sets).toHaveLength(203);
  expect(sets).toContainEqual({ role: "listing", url: set.url, headers: { accept: "application/json" } });
  expect(sets.some(({ url }) => url === "https://api.tcgdex.net/v2/en/sets/A1")).toBe(false);
  const setContext = { url: set.url, mediaType: set.mediaType, parents: [pocket, english] };
  expect(await adapter.parseBytes!(set.bytes, setContext)).toEqual([]);
  const cards = adapter.discoverRequests!(set.bytes, setContext);
  expect(cards).toHaveLength(10);
  expect(cards).toContainEqual({
    role: "detail",
    url: "https://api.tcgdex.net/v2/en/cards/tk-ex-latia-8",
    headers: { accept: "application/json" },
  });
});

test("production qualifies an issued Trainer Kit Card into one Card and Printing without inventing an image", async () => {
  const adapter = sourceAdapterForCoverage(tcgdexPokemonSourceAdapterRegistration, "english-declared-catalogue");
  const card = parent("card-tk-ex-latia-8", "detail");
  const context = {
    url: card.url,
    mediaType: card.mediaType,
    parents: [
      parent("set-tk-ex-latia", "listing"),
      parent("pocket-series", "listing"),
      parent("english-sets", "surface"),
    ],
  };
  const observations = await adapter.parseBytes!(card.bytes, context);
  expect(observations).toHaveLength(1);
  const [observation] = observations;
  expect(observation).toMatchObject({
    card: {
      game: "pokemon",
      category: "gameplay",
      official_identity: { kind: "unknown", value: null },
      name: "Potion",
      game_data: { profile: "pokemon@1", attributes: { card_type: "trainer", trainer_type: "Item" } },
    },
    card_identity_evidence: { source_design_key: "tk-ex-latia-8" },
    printing: {
      game_data: {
        attributes: { set_code: "tk-ex-latia", collector_number: "8", finish: "normal", size: "standard", stamps: [] },
      },
    },
    identity_evidence: { demonstrably_novel: false },
    appearance_evidence: { images: [] },
  });
  const parsed = parseReconciliationObservation("qualification", observation);
  if (parsed.kind !== "card_printing") throw new Error("Expected a qualified Card and Printing");
  expect(adapter.qualifiesCardDesignIdentity!(parsed)).toBe(true);
  expect(adapter.qualifiesPrintingIdentity!(parsed)).toBe(true);
  expect(adapter.discoverRequests!(card.bytes, context)).toEqual([]);
});

test("a declared-catalogue record the Game Profile cannot map stays one unresolved source record", async () => {
  const adapter = sourceAdapterForCoverage(tcgdexPokemonSourceAdapterRegistration, "english-declared-catalogue");
  const bytes = readFileSync(
    new URL("../../acceptance/fixtures/real-sources/2026-09-15-pokemon-optional-relations/raw/card-tk-ex-latia-2.body", import.meta.url),
  );
  const context = {
    url: "https://api.tcgdex.net/v2/en/cards/tk-ex-latia-2",
    mediaType: "application/json",
    parents: [
      parent("set-tk-ex-latia", "listing"),
      parent("pocket-series", "listing"),
      parent("english-sets", "surface"),
    ],
  };
  const observations = await adapter.parseBytes!(bytes, context);
  expect(observations).toHaveLength(1);
  expect(observations[0]).toMatchObject({
    observation_type: "source_admission_evidence",
    locator: "tk-ex-latia-2",
    target: { kind: "unresolved_record" },
  });
  expect(observations[0]).not.toHaveProperty("printing");
});

test("a multi-treatment record keeps every Printing distinct and associates its shared record image with none", async () => {
  const adapter = sourceAdapterForCoverage(tcgdexPokemonSourceAdapterRegistration, "english-declared-catalogue");
  const card = parent("card-base1-5", "detail");
  const context = {
    url: card.url,
    mediaType: card.mediaType,
    parents: [parent("set-base1", "listing"), parent("pocket-series", "listing"), parent("english-sets", "surface")],
  };
  const observations = (await adapter.parseBytes!(card.bytes, context)) as {
    identity_evidence: { variant_key: string };
    printing: { game_data: { attributes: Record<string, unknown> } };
    appearance_evidence: { images: unknown[] };
  }[];
  expect(observations.length).toBeGreaterThan(1);
  expect(new Set(observations.map((value) => value.identity_evidence.variant_key)).size).toBe(observations.length);
  expect(observations.every((value) => value.appearance_evidence.images.length === 0)).toBe(true);
  expect(adapter.discoverRequests!(card.bytes, context)).toEqual([]);
});

test("an unqualified foil-pattern claim keeps the whole record unresolved with its record image", async () => {
  const adapter = sourceAdapterForCoverage(tcgdexPokemonSourceAdapterRegistration, "english-declared-catalogue");
  const card = parent("card-base3-62", "detail");
  const context = {
    url: card.url,
    mediaType: card.mediaType,
    parents: [parent("set-base3", "listing"), parent("pocket-series", "listing"), parent("english-sets", "surface")],
  };
  const [observation, ...rest] = await adapter.parseBytes!(card.bytes, context);
  expect(rest).toEqual([]);
  expect(observation).toMatchObject({ observation_type: "source_admission_evidence", locator: "base3-62" });
  expect(adapter.discoverRequests!(card.bytes, context)).toEqual([
    { role: "image", url: "https://assets.tcgdex.net/en/base/base3/62/high.png", headers: { accept: "image/png" } },
  ]);
});

test("the facts scope reads the same declared root and acquires no image role", () => {
  const facts = sourceAdapterForCoverage(tcgdexPokemonSourceAdapterRegistration, "english-declared-catalogue-facts");
  expect(facts.requiredSurfaces?.map((surface) => facts.requestUrlForSurface!(surface))).toEqual([
    "https://api.tcgdex.net/v2/en/sets",
  ]);
  expect(facts.acquiredDiscoveryRoles).toEqual(["listing", "detail"]);
});

test("both pilot observations keep exact merged bytes and request capacity while graph replays require their retained membership", () => {
  const fixture = new URL("../../acceptance/fixtures/real-sources/2026-09-14-pokemon/raw/", import.meta.url);
  const adapter = tcgdexPokemonSourceAdapterRegistration;
  expect(adapter.requestCapacity).toBe(45_000);
  // Complete observation bytes computed using the actual merged dc983ca3 adapter.
  for (const [id, file, expected] of [
    ["svp-051", "tcgdex-snorlax-svp-051.body", "0271a342587f8bd935fad3f3b03cb531182adc4004ac0a47432904e15190fd1b"],
    ["base1-4", "tcgdex-charizard-base1-4.body", "7975f897d8f6aa418eb69a10a0522bf2d7784a4064982741eb6455d1933784a2"],
  ] as const) {
    const bytes = readFileSync(new URL(file, fixture));
    const context = { url: `https://api.tcgdex.net/v2/en/cards/${id}`, mediaType: "application/json" };
    expect(
      createHash("sha256")
        .update(JSON.stringify(adapter.parseBytes(bytes, context)))
        .digest("hex"),
    ).toBe(expected);
    const wrongParents = {
      ...context,
      parents: [
        parent("set-tk-ex-latia", "listing"),
        parent("pocket-series", "listing"),
        parent("english-sets", "surface"),
      ],
    };
    expect(() => adapter.parseBytes(bytes, wrongParents)).toThrow();
    expect(() => adapter.discoverRequests(bytes, wrongParents)).toThrow();
  }
});

test("both Pokémon registrations pace publisher pages sequentially and cite retained access evidence", async () => {
  const { pokemonOfficialSourceAdapterRegistration } = await import(
    "../../src/catalogue/adapters/pokemon-official-source-adapter"
  );
  const declared = [tcgdexPokemonSourceAdapterRegistration, pokemonOfficialSourceAdapterRegistration].flatMap(
    (adapter) => adapter.hostPacing.map((policy) => [policy.hostname, policy.kind, policy.maximumConcurrency]),
  );
  expect(declared).toEqual([
    ["api.tcgdex.net", "page", 1],
    ["assets.tcgdex.net", "asset", 2],
    ["www.pokemon.com", "page", 1],
    ["assets.pokemon.com", "asset", 1],
  ]);
  for (const adapter of [tcgdexPokemonSourceAdapterRegistration, pokemonOfficialSourceAdapterRegistration])
    for (const policy of adapter.hostPacing) expect(policy.evidence).toMatch(/^acceptance\/fixtures\/real-sources\//u);
});
