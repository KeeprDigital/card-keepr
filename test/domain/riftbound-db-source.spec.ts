import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { requiredSourceAdapter, sourceAdapterForCoverage } from "../../src/catalogue/adapters/source-adapters";
import { parseSourceAdmissionEvidence } from "../../src/catalogue/reconciliation/source-admission-evidence";
import { parseReconciliationObservation } from "../../src/catalogue/reconciliation/reconciliation-observation";
import { AdapterParseFailure } from "../../src/catalogue/adapters/adapter-parse-failure";
import {
  syntheticRiftboundDbCardsPage,
  syntheticRiftboundDbFacets,
  syntheticRiftboundDbRecords,
} from "../support/synthetic-riftbound-db-pages.mjs";

const fixture = "acceptance/fixtures/real-sources/2026-09-14-riftbound-db/raw/";
const origin = "https://www.riftbound-db.com";

test("Riftbound DB retains real duplicate promo claims without allocating unqualified identities", async () => {
  const adapter = requiredSourceAdapter("riftbound-db-en@1");
  const promo = await adapter.parseBytes!(readFileSync(`${fixture}pr-page-1-size-3.json`), {
    url: `${origin}/api/cards?set=PR&page=1&pageSize=3`,
    mediaType: "application/json",
  });
  const search = await adapter.parseBytes!(readFileSync(`${fixture}bird-page-1-size-3.json`), {
    url: `${origin}/api/cards?q=Bird&page=1&pageSize=3`,
    mediaType: "application/json",
  });
  expect(promo).toHaveLength(3);
  for (const claim of promo) {
    expect(claim).toMatchObject({
      observation_type: "source_admission_evidence",
      game: "riftbound",
      source_lineage: "riftbound-db-en",
      target: { kind: "unresolved_record" },
    });
    expect(claim).not.toHaveProperty("card");
    expect(claim).not.toHaveProperty("printing");
  }
  const bird = "openrift-019e1fea-0113-7f38-b59d-23cab5997383";
  const claims = (values: readonly unknown[]) =>
    values as { locator: string; source_sidecar: { source_record_json: string } }[];
  expect(claims(search).find((claim) => claim.locator === bird)).toEqual(
    claims(promo).find((claim) => claim.locator === bird),
  );
  const raw = JSON.parse(claims(promo)[1]!.source_sidecar.source_record_json);
  expect(raw.raw.openrift).toMatchObject({ publicCode: "UNL-T02-P", finish: "foil", channelPath: ["Unleashed Vault"] });
  expect(adapter.printingAdmission).toBe("owner_review");
});

test("Riftbound DB bounds retained facets and pagination without claiming or following a full inventory", async () => {
  const adapter = requiredSourceAdapter("riftbound-db-en@1");
  const context = { url: `${origin}/api/facets`, mediaType: "application/json" };
  expect(await adapter.parseBytes!(readFileSync(`${fixture}facets.json`), context)).toEqual([]);
  expect(adapter.discoverRequests!(readFileSync(`${fixture}facets.json`), context)).toEqual([]);
  expect(adapter.requiredSurfaces).toContain("facets");
  const url = `${origin}/api/cards?set=PR&page=1&pageSize=3`;
  const source = JSON.parse(readFileSync(`${fixture}pr-page-1-size-3.json`, "utf8"));
  for (const malformed of [
    { ...source, pagination: { ...source.pagination, hasMore: false } },
    { ...source, cards: [source.cards[0], source.cards[0]] },
    { ...source, cards: source.cards.slice(0, 2) },
  ])
    expect(() =>
      adapter.parseBytes!(new TextEncoder().encode(JSON.stringify(malformed)), { url, mediaType: "application/json" }),
    ).toThrow(AdapterParseFailure);
  expect(() =>
    adapter.parseBytes!(readFileSync(`${fixture}pr-page-1-size-3.json`), {
      url: url.replace("page=1", "page=2"),
      mediaType: "application/json",
    }),
  ).toThrow(AdapterParseFailure);
});

test("Riftbound DB promo evidence satisfies the retained review contract without a partial Game Profile", async () => {
  const adapter = requiredSourceAdapter("riftbound-db-en@1");
  const values = await adapter.parseBytes!(readFileSync(`${fixture}pr-page-1-size-3.json`), {
    url: `${origin}/api/cards?set=PR&page=1&pageSize=3`,
    mediaType: "application/json",
  });
  for (const value of values) expect(parseSourceAdmissionEvidence(value, adapter)).toEqual(value);
});

test("Eclipse Herald maps its evidenced Riot overlap while original promo images stay private source-record evidence", async () => {
  const adapter = requiredSourceAdapter("riftbound-db-en@1");
  const context = { url: `${origin}/api/cards?q=Bird&page=1&pageSize=3`, mediaType: "application/json" };
  const values = await adapter.parseBytes!(readFileSync(`${fixture}bird-page-1-size-3.json`), context);
  const eclipse = values.find((value) => typeof value === "object" && value !== null && "card" in value);
  const parsed = parseReconciliationObservation("retained-eclipse", eclipse);
  expect(parsed).toMatchObject({
    kind: "card_printing",
    observedCardAndPrinting: {
      card: {
        name: "Eclipse Herald",
        category: "gameplay",
        official_identity: { kind: "publisher_name", value: "Eclipse Herald" },
        game_data: {
          profile: "riftbound@1",
          attributes: {
            card_types: ["unit"],
            supertypes: [],
            domains: ["calm"],
            energy: 7,
            power: 1,
            might: 7,
            might_bonus: null,
            tags: ["Bird", "Mount Targon"],
            effect_text: null,
          },
        },
      },
      printing: {
        printed_rules_text: null,
        game_data: { attributes: { public_code: "OGN-059/298", finish: null, reverse_face: null } },
      },
    },
  });
  const promo = await adapter.parseBytes!(readFileSync(`${fixture}pr-page-1-size-3.json`), {
    url: `${origin}/api/cards?set=PR&page=1&pageSize=3`,
    mediaType: "application/json",
  });
  for (const value of promo) {
    const review = parseSourceAdmissionEvidence(value, adapter);
    expect(review.appearance_evidence.images).toHaveLength(1);
    expect(review.appearance_evidence.images[0]).toMatchObject({ association: "source_record", role: "front" });
  }
  expect(adapter.discoverRequests!(readFileSync(`${fixture}bird-page-1-size-3.json`), context)).toHaveLength(2);
});

test("Riftbound DB rejects contradictory raw source identity before qualifying the overlap", () => {
  const adapter = requiredSourceAdapter("riftbound-db-en@1");
  const page = JSON.parse(readFileSync(`${fixture}bird-page-1-size-3.json`, "utf8"));
  page.cards[1].raw.id = "different-source-record";
  expect(() =>
    adapter.parseBytes!(new TextEncoder().encode(JSON.stringify(page)), {
      url: `${origin}/api/cards?q=Bird&page=1&pageSize=3`,
      mediaType: "application/json",
    }),
  ).toThrow(AdapterParseFailure);
});

describe("Riftbound DB set census", () => {
  const adapter = () => requiredSourceAdapter("riftbound-db-en@1");
  const json = "application/json";
  const facetsUrl = `${origin}/api/facets`;
  const censusPage = (set: string, page: number) => `${origin}/api/cards?set=${set}&page=${page}&pageSize=80`;
  const facetsBytes = readFileSync(`${fixture}facets.json`);
  const promo = JSON.parse(readFileSync(`${fixture}pr-page-1-size-3.json`, "utf8")).cards;
  const search = JSON.parse(readFileSync(`${fixture}bird-page-1-size-3.json`, "utf8")).cards;
  const [eclipse, anivia] = [search[1], search[2]];
  const facetsParent = {
    requestId: "riftbound-db-en:set-census",
    snapshotId: "snapshot-facets",
    role: "listing",
    url: facetsUrl,
    mediaType: json,
    retrievedAt: "2026-09-14T14:09:12.000Z",
    contentSha256: "retained",
    bytes: facetsBytes,
  };
  const bytes = (body: string) => new TextEncoder().encode(body);
  const pageBytes = (page: number, total: number, cards: unknown[]) =>
    bytes(syntheticRiftboundDbCardsPage({ page, total, cards }));
  const pageParent = (set: string, total: number, cards: unknown[]) => ({
    ...facetsParent,
    requestId: "page-1",
    url: censusPage(set, 1),
    bytes: pageBytes(1, total, cards),
  });
  const parse = async (body: Uint8Array, set: string, page: number, parents: unknown[]) =>
    (await adapter().parseBytes!(body, {
      url: censusPage(set, page),
      mediaType: json,
      parents: parents as never,
    })) as Record<string, unknown>[];

  test("the census root discovers page 1 of every set bucket the facets list, while the pilot facets discover nothing", () => {
    const root = { url: facetsUrl, mediaType: json, requestId: "riftbound-db-en:set-census" };
    const requests = adapter().discoverRequests!(facetsBytes, root);
    expect(requests.map((request) => request.url)).toEqual(
      ["ARC", "JDG", "LGC", "OGN", "OGS", "OPP", "PR", "RAD", "SFD", "UNL", "VEN"].map((set) => censusPage(set, 1)),
    );
    expect(requests.every((request) => request.role === "listing")).toBe(true);
    expect(adapter().discoverRequests!(facetsBytes, { ...root, requestId: "riftbound-db-en:facets" })).toEqual([]);
    const sets = (value: unknown) =>
      adapter().discoverRequests!(bytes(syntheticRiftboundDbFacets(JSON.parse(facetsBytes.toString()), value)), root);
    for (const invalid of [[], ["PR", "PR"], ["pr"], Array.from({ length: 33 }, (_, index) => `S${index + 10}`)])
      expect(() => sets(invalid), JSON.stringify(invalid)).toThrow(AdapterParseFailure);
    expect(sourceAdapterForCoverage(adapter(), "set-census").requestUrlForSurface!("set-census")).toBe(facetsUrl);
  });

  test("a bucket page retains every record for review and fetches only fronts hosted on OpenRift", async () => {
    const values = await parse(pageBytes(1, 3, promo), "PR", 1, [facetsParent]);
    expect(values).toHaveLength(3);
    for (const value of values) {
      const review = parseSourceAdmissionEvidence(value, adapter());
      expect(review).toMatchObject({ target: { kind: "unresolved_record" } });
      expect(review.issues.map((issue) => issue.code)).toEqual([
        "card_identity_unresolved",
        "printing_treatment_unresolved",
        "physical_issuance_unresolved",
      ]);
      expect(JSON.parse(review.source_sidecar.source_record_json).census_page).toEqual({
        set: "PR",
        page: 1,
        page_size: 80,
        total: 3,
      });
    }
    // Pinned promo fronts keep their retained digests.
    expect(
      values.map((value) => (value as { appearance_evidence: { images: unknown[] } }).appearance_evidence.images),
    ).toEqual(
      promo.map((card: { imageSourceUrl: string }) => [
        expect.objectContaining({ source_url: card.imageSourceUrl, content_sha256: expect.any(String) }),
      ]),
    );
    const unpinned = { ...promo[0], id: "openrift-synthetic", raw: { ...promo[0].raw, id: "openrift-synthetic" } };
    delete unpinned.raw.openrift;
    const mixed = [unpinned, eclipse, anivia];
    const requests = adapter().discoverRequests!(pageBytes(1, 3, mixed), {
      url: censusPage("OGN", 1),
      mediaType: json,
      parents: [facetsParent],
    });
    // Anivia's front is on Riot's CDN and is not fetched; Eclipse keeps its pinned overlap front.
    expect(requests.map((request) => new URL(request.url).hostname)).toEqual(["openrift.app", "cmsassets.rgpub.io"]);
    const observations = await parse(pageBytes(1, 3, mixed), "OGN", 1, [facetsParent]);
    expect(observations[1]).toHaveProperty("card.name", "Eclipse Herald");
    expect(observations[2]).toMatchObject({ locator: anivia.id, appearance_evidence: { images: [] } });
    expect(observations[0]).not.toHaveProperty("appearance_evidence.images.0.content_sha256");
  });

  test("page 1 discovers every page its total implies and later pages must match it", async () => {
    const first = syntheticRiftboundDbRecords(anivia, 80, "first");
    const last = syntheticRiftboundDbRecords(anivia, 5, "last");
    const requests = adapter().discoverRequests!(pageBytes(1, 165, first), {
      url: censusPage("OGN", 1),
      mediaType: json,
      parents: [facetsParent],
    });
    expect(requests.map((request) => request.url)).toEqual([censusPage("OGN", 2), censusPage("OGN", 3)]);
    const parent = pageParent("OGN", 165, first);
    expect(await parse(pageBytes(3, 165, last), "OGN", 3, [parent])).toHaveLength(5);
    const drifted: [Uint8Array, number, unknown[]][] = [
      [pageBytes(3, 165, last), 3, []],
      [pageBytes(3, 166, [...last, anivia]), 3, [parent]],
      [pageBytes(2, 165, first.slice(0, 79)), 2, [parent]],
      [pageBytes(3, 165, last.slice(0, 4)), 3, [parent]],
      [pageBytes(4, 165, last.slice(0, 1)), 4, [parent]],
      [pageBytes(1, 165, first), 1, []],
      [pageBytes(1, 2, [anivia, anivia]), 1, [facetsParent]],
      [
        bytes(JSON.stringify({ cards: last, pagination: { page: 3, pageSize: 80, total: 165, hasMore: true } })),
        3,
        [parent],
      ],
      [pageBytes(1, 80 * 200 + 1, first), 1, [facetsParent]],
    ];
    for (const [index, [body, page, parents]] of drifted.entries())
      await expect(parse(body, "OGN", page, parents), `drift case ${index}`).rejects.toThrow(AdapterParseFailure);
    await expect(parse(pageBytes(1, 0, []), "ZZZ", 1, [facetsParent])).rejects.toThrow(AdapterParseFailure);
    expect(await parse(pageBytes(1, 0, []), "ARC", 1, [facetsParent])).toEqual([]);
  });

  test("a changed Eclipse Herald becomes a census review record while the pilot fails closed", async () => {
    const changed = { ...eclipse, artist: "Another Studio" };
    const [value] = await parse(pageBytes(1, 1, [changed]), "OGN", 1, [facetsParent]);
    expect(JSON.parse(parseSourceAdmissionEvidence(value, adapter()).source_sidecar.source_record_json)).toMatchObject({
      pinned_qualification: "changed",
      artist: "Another Studio",
    });
    const pilot = JSON.parse(readFileSync(`${fixture}bird-page-1-size-3.json`, "utf8"));
    pilot.cards[1].artist = "Another Studio";
    expect(() =>
      adapter().parseBytes!(bytes(JSON.stringify(pilot)), {
        url: `${origin}/api/cards?q=Bird&page=1&pageSize=3`,
        mediaType: json,
      }),
    ).toThrow(AdapterParseFailure);
  });

  test("the census declares polite pacing for the API and the OpenRift front host", () => {
    expect(
      adapter().hostPacing?.map((policy) => [policy.hostname, policy.kind, policy.floorMs, policy.maximumConcurrency]),
    ).toEqual([
      ["www.riftbound-db.com", "page", 2_000, 1],
      ["openrift.app", "asset", 250, 2],
    ]);
  });
});
