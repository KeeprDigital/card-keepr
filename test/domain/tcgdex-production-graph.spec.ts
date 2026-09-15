import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { URL } from "node:url";
import { expect, test } from "vitest";
import { sourceAdapterForCoverage } from "../../src/catalogue/adapters/source-adapters";
import { tcgdexPokemonSourceAdapterRegistration } from "../../src/catalogue/adapters/tcgdex-pokemon-source-adapter";
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

test("production retains an exact Trainer Kit Card as one unresolved source record without inventing an image", async () => {
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
  expect(observations[0]).toMatchObject({
    observation_type: "source_admission_evidence",
    game: "pokemon",
    source_lineage: "tcgdex-pokemon-en",
    locator: "tk-ex-latia-8",
    source_membership: { set_id: "tk-ex-latia", local_id: "8" },
    target: { kind: "unresolved_record" },
    source_sidecar: { source_record_json: new TextDecoder().decode(card.bytes) },
    appearance_evidence: {
      images: [],
    },
  });
  expect(observations[0]).not.toHaveProperty("card");
  expect(observations[0]).not.toHaveProperty("printing");
  expect(adapter.discoverRequests!(card.bytes, context)).toEqual([]);
});

test("both pilot observations keep exact merged bytes and request capacity while graph replays require their retained membership", () => {
  const fixture = new URL("../../acceptance/fixtures/real-sources/2026-09-14-pokemon/raw/", import.meta.url);
  const adapter = tcgdexPokemonSourceAdapterRegistration;
  expect(adapter.requestCapacity).toBe(4);
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
