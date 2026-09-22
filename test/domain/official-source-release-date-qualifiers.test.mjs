import { test } from "vitest";
import assert from "node:assert/strict";
import { normalizedOfficialReleaseDate } from "../../src/catalogue/adapters/official-source-release-normalization.ts";
import { retainedProductDetail, retainedOfficialSourceFixture } from "./official-source-raw-contract-shared.mjs";
import { requiredSourceAdapter } from "../../src/catalogue/adapters/source-adapters.ts";
import { reconcileProductReleaseCatalogue } from "../../src/catalogue/reconciliation/product-release-catalogue.ts";

// Bandai appends event text to a day date (live ib-ex01.php, 2026-09-22). The
// leading date is the Release date and the qualifier is retained verbatim as
// unmapped evidence with a precise review warning (issue #334).

test("a recognised leading day date keeps its qualifier verbatim", () => {
  assert.deepEqual(
    normalizedOfficialReleaseDate("March 8, 2025 Pre-Sale at ONE PIECE DAY Dallas -Card Game Celebration-"),
    {
      precision: "day",
      value: "2025-03-08",
      qualifier: "Pre-Sale at ONE PIECE DAY Dallas -Card Game Celebration-",
    },
  );
  assert.deepEqual(normalizedOfficialReleaseDate("8 March 2025 Pre-Sale"), {
    precision: "day",
    value: "2025-03-08",
    qualifier: "Pre-Sale",
  });
  // The #390 tentative marker is unchanged, alone and after a qualifier.
  assert.deepEqual(normalizedOfficialReleaseDate("September 30, 2022 (Subject to change)"), {
    precision: "day",
    value: "2022-09-30",
    tentative: true,
  });
  assert.deepEqual(normalizedOfficialReleaseDate("March 8, 2025 Pre-Sale (Subject to change)"), {
    precision: "day",
    value: "2025-03-08",
    qualifier: "Pre-Sale",
    tentative: true,
  });
  // A qualifier with no recognisable leading day date still fails closed.
  for (const text of [
    "Pre-Sale at ONE PIECE DAY Dallas",
    "March 2025 Pre-Sale",
    "Fooday 8, 2025 Pre-Sale",
    "2025 Pre-Sale",
  ])
    assert.throws(() => normalizedOfficialReleaseDate(text), /Unrecognized official Release date/u, text);
});

test("the retained live One Piece event product records the leading date and flags the qualifier", () => {
  const adapter = requiredSourceAdapter("one-piece-en@6");
  const fixture = retainedOfficialSourceFixture("one-piece-en-product-event-qualified-release");
  assert.equal(fixture.metadata.source_url, "https://en.onepiece-cardgame.com/products/other/ib-ex01.php");
  const [observation] = adapter.parseBytes(fixture.bytes, {
    mediaType: "text/html",
    url: fixture.metadata.source_url,
    requestId: `one-piece-en:product_detail:${"0".repeat(64)}`,
  });
  const releases = observation.product_release_catalogue.products.flatMap((product) => product.releases);
  assert.equal(releases.length, 1);
  assert.deepEqual(releases[0].date, { precision: "day", value: "2025-03-08" });
  const qualifier = observation.source_sidecar.unmapped_optional_fields.filter(({ path }) =>
    path.includes(".release_date_qualifier:"),
  );
  assert.deepEqual(qualifier, [
    {
      path: "source_sidecar.raw.official_surfaces[0].document.release_date_qualifier:Release Date",
      value: "Pre-Sale at ONE PIECE DAY Dallas -Card Game Celebration-",
    },
  ]);
  assert.ok(
    !observation.source_sidecar.consumed_fields.includes(qualifier[0].path),
    "the qualifier is not reported as consumed",
  );
  // The retained raw label keeps the full Publisher text.
  assert.match(
    retainedProductDetail("one-piece-en", "one-piece-en-product-event-qualified-release").document["Release Date"],
    /Pre-Sale at ONE PIECE DAY Dallas/u,
  );
});

test("reconciliation raises a precise review warning for the retained qualifier", async () => {
  const { parseReconciliationObservation } =
    await import("../../src/catalogue/reconciliation/reconciliation-observation.ts");
  const adapter = requiredSourceAdapter("one-piece-en@6");
  const fixture = retainedOfficialSourceFixture("one-piece-en-product-event-qualified-release");
  const [observation] = adapter.parseBytes(fixture.bytes, {
    mediaType: "text/html",
    url: fixture.metadata.source_url,
    requestId: `one-piece-en:product_detail:${"0".repeat(64)}`,
  });
  const parsed = parseReconciliationObservation("srcobs_ibex01", observation);
  const warnings = parsed.sourceWarnings.filter(({ code }) => code === "release_date_qualifier_retained");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].raw_value, "Pre-Sale at ONE PIECE DAY Dallas -Card Game Celebration-");
  assert.equal(
    parsed.sourceWarnings.some(
      ({ code, path }) => code === "unknown_source_field" && path.includes("release_date_qualifier"),
    ),
    false,
  );
  const reconciled = await reconcileProductReleaseCatalogue(
    null,
    [
      {
        value: observation.product_release_catalogue,
        sourceObservationId: "srcobs_ibex01",
        sourceObservationSetId: "set_ibex01",
        sourceSnapshotId: "snap_ibex01",
        sourceLineage: "one-piece-en",
        sourceSurface: "product-detail",
        requestRole: "product_detail",
        capturedAt: "2026-09-22T00:56:52.000Z",
        currentCardId: null,
        currentPrintingId: null,
      },
    ],
    "one-piece",
  );
  assert.deepEqual(reconciled.products[0].releases[0].date, { precision: "day", value: "2025-03-08" });
});
