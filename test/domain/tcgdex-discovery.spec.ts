import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { expect, test } from "vitest";
import { tcgdexDiscoveryRequests, qualifiedTcgdexCard } from "../../src/catalogue/adapters/tcgdex-discovery";
import type { SourceAdapterParent } from "../../src/catalogue/adapters/source-adapter-registration-types";

const fixture = new URL("../../acceptance/fixtures/real-sources/2026-09-15-pokemon-scope/raw/", import.meta.url);
const bytes = (name: string) => readFileSync(new URL(name, fixture));
const manifest = JSON.parse(readFileSync(new URL("../manifest.json", fixture), "utf8")) as {
  captures: { id: string; url: string; finishedAt: string; sha256: string; body: string }[];
};
function parent(id: string, role: string): SourceAdapterParent {
  const capture = manifest.captures.find((entry) => entry.id === id)!;
  return {
    requestId: `fixture-${id}`,
    snapshotId: `fixture-snapshot-${id}`,
    role,
    url: capture.url,
    mediaType: "application/json",
    retrievedAt: capture.finishedAt,
    contentSha256: capture.sha256,
    bytes: readFileSync(new URL(`../${capture.body}`, fixture)),
  };
}
const english: SourceAdapterParent = {
  ...parent("english-sets", "surface"),
};

test("both declared inventories must be retained before discovering the exact non-Pocket set requests", () => {
  expect(
    tcgdexDiscoveryRequests(english.bytes, { url: english.url, mediaType: "application/json", parents: [] }),
  ).toEqual([
    { role: "listing", url: "https://api.tcgdex.net/v2/en/series/tcgp", headers: { accept: "application/json" } },
  ]);
  const context = {
    url: "https://api.tcgdex.net/v2/en/series/tcgp",
    mediaType: "application/json",
    parents: [english],
  };
  const requests = tcgdexDiscoveryRequests(bytes("pocket-series.body"), context);
  expect(requests).toHaveLength(203);
  expect(requests).toContainEqual({
    role: "listing",
    url: "https://api.tcgdex.net/v2/en/sets/tk-ex-latia",
    headers: { accept: "application/json" },
  });
  expect(requests.some((request) => request.url === "https://api.tcgdex.net/v2/en/sets/A1")).toBe(false);
  expect(() => tcgdexDiscoveryRequests(bytes("pocket-series.body"), { ...context, parents: [] })).toThrow();
});

test("a set discovers only its complete retained membership with the exact set/local boundary", () => {
  const parents = [parent("pocket-series", "listing"), english];
  const requests = tcgdexDiscoveryRequests(bytes("set-tk-ex-latia.body"), {
    url: "https://api.tcgdex.net/v2/en/sets/tk-ex-latia",
    mediaType: "application/json",
    parents,
  });
  expect(requests).toHaveLength(10);
  expect(requests).toContainEqual({
    role: "detail",
    url: "https://api.tcgdex.net/v2/en/cards/tk-ex-latia-8",
    headers: { accept: "application/json" },
  });
  const brilliantStars = tcgdexDiscoveryRequests(bytes("set-swsh9.body"), {
    url: "https://api.tcgdex.net/v2/en/sets/swsh9",
    mediaType: "application/json",
    parents,
  });
  expect(brilliantStars).toHaveLength(186);
  expect(brilliantStars).toContainEqual({
    role: "detail",
    url: "https://api.tcgdex.net/v2/en/cards/swsh9-053",
    headers: { accept: "application/json" },
  });
  expect(() =>
    tcgdexDiscoveryRequests(bytes("set-tk-ex-latia.body"), {
      url: "https://api.tcgdex.net/v2/en/sets/tk-ex-latia",
      mediaType: "application/json",
      parents: [english],
    }),
  ).toThrow();
});

test("a full Card record must match its own retained set membership before contributing content", () => {
  const context = {
    url: "https://api.tcgdex.net/v2/en/cards/tk-ex-latia-8",
    mediaType: "application/json",
    parents: [parent("set-tk-ex-latia", "listing"), parent("pocket-series", "listing"), english],
  };
  const qualified = qualifiedTcgdexCard(bytes("card-tk-ex-latia-8.body"), context);
  expect(qualified).toMatchObject({
    card: { id: "tk-ex-latia-8", localId: "8", category: "Trainer" },
    membership: { id: "tk-ex-latia-8", localId: "8", url: context.url },
    set: { id: "tk-ex-latia", seriesId: "tk", releaseDate: "2004-07-01", eligibility: "issued_set_candidate" },
  });
  expect(qualified.set).not.toHaveProperty("cards");
  expect(() =>
    qualifiedTcgdexCard(bytes("card-tk-ex-latia-8.body"), {
      ...context,
      parents: [parent("set-base4", "listing"), ...context.parents.slice(1)],
    }),
  ).toThrow();
  const changed = JSON.parse(bytes("card-tk-ex-latia-8.body").toString());
  changed.localId = "08";
  expect(() => qualifiedTcgdexCard(new TextEncoder().encode(JSON.stringify(changed)), context)).toThrow();
});
