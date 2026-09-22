import { test } from "vitest";
import assert from "node:assert/strict";
import { normalizedOfficialReleaseDate } from "../../src/catalogue/adapters/official-source-release-normalization.ts";
import { liveOfficialReleaseDateText } from "../../src/catalogue/adapters/adapter-html.ts";
import { requiredSourceAdapter } from "../../src/catalogue/adapters/source-adapters.ts";
import { reconcileProductReleaseCatalogue } from "../../src/catalogue/reconciliation/product-release-catalogue.ts";
import {
  retainedOfficialSourceFixture,
  retainedProductDetail,
  restructuredStageDigest,
} from "./official-source-raw-contract-shared.mjs";

// Bandai marks some announced dates "(Subject to change)". The date is the
// Publisher's stated date and is kept, with the marker recorded as an explicit
// tentative flag on the Release rather than rejecting the page (issue #334).

test("a tentative marker keeps the stated date and flags it", () => {
  for (const [text, expected] of [
    ["September 30, 2022 (Subject to change)", { precision: "day", value: "2022-09-30", tentative: true }],
    ["September 30, 2022(subject to change)", { precision: "day", value: "2022-09-30", tentative: true }],
    ["2026-11 (Subject to change)", { precision: "month", value: "2026-11", tentative: true }],
    ["September 30, 2022", { precision: "day", value: "2022-09-30" }],
  ])
    assert.deepEqual(normalizedOfficialReleaseDate(text), expected, text);
  assert.deepEqual(normalizedOfficialReleaseDate("Winter, 2026 (Subject to change)", { seasons: true }), {
    precision: "season",
    value: "2026-winter",
    tentative: true,
  });
  // Live shorthand is still normalized when the marker follows it.
  assert.deepEqual(
    normalizedOfficialReleaseDate(liveOfficialReleaseDateText("September 25,2026 (Subject to change)")),
    {
      precision: "day",
      value: "2026-09-25",
      tentative: true,
    },
  );
  // The marker does not make an unrecognized or absent date acceptable.
  assert.throws(() => normalizedOfficialReleaseDate("(Subject to change)"), /Unrecognized official Release date/u);
  assert.throws(() => normalizedOfficialReleaseDate("Soon (Subject to change)"), /Unrecognized official Release date/u);
  assert.throws(
    () => normalizedOfficialReleaseDate("September 30, 2022 (Limited stores)"),
    /Unrecognized official Release date/u,
  );
});

test("the retained live One Piece pre-release deck page records a tentative Release", () => {
  const { catalogue, fixture } = retainedProductDetail("one-piece-en", "one-piece-en-product-starter-deck-tentative");
  assert.equal(fixture.metadata.source_url, "https://en.onepiece-cardgame.com/products/decks/st01-04_pre.php");
  const releases = catalogue.products.flatMap((product) => product.releases);
  assert.equal(releases.length, 1);
  assert.deepEqual(releases[0].date, { precision: "day", value: "2022-09-30", tentative: true });
});

const lineagePages = [
  ["one-piece-en", "one-piece-en-product-starter-deck-tentative", null, null],
  [
    "digimon-en",
    "digimon-en-product-starter-deck",
    "<dd>May 15, 2026</dd>",
    "<dd>May 15, 2026<br>(Subject to change)</dd>",
  ],
  [
    "gundam-en-asia",
    "gundam-en-asia-product-booster",
    "<dd>July 25, 2026</dd>",
    "<dd>July 25, 2026<br>(Subject to change)</dd>",
  ],
  [
    "fusion-world-en",
    "fusion-world-en-product-starter-deck",
    "<p>March 13, 2026</p>",
    "<p>March 13, 2026<br>(Subject to change)</p>",
  ],
];

for (const [lineage, slug, plain, marked] of lineagePages) {
  test(`${lineage} product detail records the tentative marker and nothing else changes`, async () => {
    const adapter = [
      ...(await import("../../src/catalogue/adapters/source-adapters.ts")).sourceAdapterRegistrations,
    ].find((candidate) => candidate.sourceLineage === lineage && candidate.officialSourceContract !== undefined);
    const fixture = retainedOfficialSourceFixture(slug);
    const html = fixture.bytes.toString("utf8");
    const parse = (body) =>
      adapter
        .parseBytes(Buffer.from(body, "utf8"), {
          mediaType: fixture.metadata.content_type,
          url: fixture.metadata.source_url,
          requestId: `${lineage}:product_detail:${restructuredStageDigest}`,
        })[0]
        .product_release_catalogue.products.flatMap((product) => product.releases);
    const [markedBody, plainBody] =
      plain === null ? [html, html.replace(/<br>\s*\(Subject to change\)/u, "")] : [html.replace(plain, marked), html];
    assert.notEqual(markedBody, plainBody);
    const [tentative] = parse(markedBody);
    const [stated] = parse(plainBody);
    assert.equal(tentative.date.tentative, true);
    assert.equal("tentative" in stated.date, false);
    assert.deepEqual(
      { ...tentative, date: { ...tentative.date, tentative: undefined } },
      {
        ...stated,
        date: { ...stated.date, tentative: undefined },
      },
    );
  });
}

test("the Fusion World listing RELEASE cell accepts a tentative marker", () => {
  assert.deepEqual(
    normalizedOfficialReleaseDate(liveOfficialReleaseDateText("2027.1.30 (Subject to change)"), { seasons: true }),
    {
      precision: "day",
      value: "2027-01-30",
      tentative: true,
    },
  );
});

function releaseInput(id, date, capturedAt) {
  return {
    value: {
      products: [
        {
          reference: { kind: "official_code", value: "ST-04 PRE" },
          official_code: "ST-04 PRE",
          name: "STARTER DECK -Animal Kingdom Pirates-",
          releases: [{ event_key: "product-release:ST-04 PRE", region: "unknown", date, status: null }],
        },
      ],
      distribution_contexts: [],
      relationships: [],
    },
    sourceObservationId: id,
    sourceObservationSetId: `set_${id}`,
    sourceSnapshotId: `snap_${id}`,
    sourceLineage: "one-piece-en",
    sourceSurface: "product-detail",
    requestRole: "product_detail",
    capturedAt,
    currentCardId: null,
    currentPrintingId: null,
  };
}

test("the export Release record admits the tentative marker and nothing but true", async () => {
  const { verifyExportRecord } = await import("../../src/catalogue/export/export-validation.ts");
  const release = {
    type: "release",
    id: "release_st04pre",
    product_id: "product_st04pre",
    event_key: "product-release_st04pre",
    region: "unknown",
    date: { precision: "day", value: "2022-09-30" },
    status: null,
  };
  verifyExportRecord(release);
  verifyExportRecord({ ...release, date: { ...release.date, tentative: true } });
  assert.throws(() => verifyExportRecord({ ...release, date: { ...release.date, tentative: false } }));
});

test("a later observation without the marker updates the tentative Release normally", async () => {
  const first = await reconcileProductReleaseCatalogue(
    null,
    [releaseInput("obs_1", { precision: "day", value: "2022-09-30", tentative: true }, "2022-08-01T00:00:00.000Z")],
    "one-piece",
  );
  assert.deepEqual(first.products[0].releases[0].date, { precision: "day", value: "2022-09-30", tentative: true });
  const refreshed = await reconcileProductReleaseCatalogue(
    first,
    [releaseInput("obs_2", { precision: "day", value: "2022-10-07" }, "2022-10-01T00:00:00.000Z")],
    "one-piece",
  );
  assert.deepEqual(refreshed.products[0].releases[0].date, { precision: "day", value: "2022-10-07" });
  assert.equal(refreshed.products[0].releases[0].id, first.products[0].releases[0].id);
  // An unrelated lineage's refresh carries the tentative Release forward unchanged.
  const carried = await reconcileProductReleaseCatalogue(first, [], "one-piece");
  assert.deepEqual(carried.products[0].releases[0].date, { precision: "day", value: "2022-09-30", tentative: true });
  assert.equal(requiredSourceAdapter("one-piece-en@6").sourceLineage, "one-piece-en");
});
