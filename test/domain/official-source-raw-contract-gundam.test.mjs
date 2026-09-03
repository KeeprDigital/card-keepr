import { test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  adapterReconciliationAreas,
  assertAdapterBinding,
  installedSourceAdapterRegistrations,
  requiredActiveSourceAdapter,
  requiredSourceAdapter,
  sourceAdapterRegistrations,
} from "../../src/catalogue/source-adapters.ts";
import syntheticOfficialSource, {
  officialBandaiNavigationHeader,
  officialDiscoveryDefinitions,
  officialDiscoveryDocument,
  officialPublisherPayloadScript,
  officialRawSurfacePayload,
} from "../../acceptance/fixtures/synthetic-official-source.mjs";
import {
  retainedOfficialSourceFixture,
  retainedLegalityRules,
  restructuredStageDigest,
  retainedRestructuredParse,
  retainedRestructuredRequests,
  stageRecordSummaries,
  activeProductionAdapter,
  retainedProductDetail,
  retainedAccessoryContext,
  rawSurfacePayload,
  parseRegisteredSurface,
} from "./official-source-raw-contract-shared.mjs";

test("the live Gundam adapters close package leaves by full locator", () => {
  for (const lineage of ["gundam-en-asia", "gundam-en-us"]) {
    const current = requiredSourceAdapter(`${lineage}@7`);
    const payload = rawSurfacePayload(lineage, "packages");

    const complete = structuredClone(payload);
    const detail = complete.card_details[0];
    delete detail.artwork_fingerprint;
    delete detail.printed_fields_digest;
    delete detail.printing.normalized_rarity;
    complete.package_options = [
      { value: "gd01", label: "GD01" },
      { value: "starter", label: "Starter decks" },
    ];
    const entry = complete.result.partitions[0].entries[0];
    complete.result.partitions = ["gd01", "starter"].map((name) => ({
      bucket: `package=${name}`,
      page: 1,
      pages: 1,
      total: 1,
      has_next: false,
      entries: [structuredClone(entry)],
    }));

    const observations = parseRegisteredSurface(current, "packages", complete);
    assert.equal(
      observations.filter(({ card }) => card !== undefined).length,
      1,
      "the same full locator is deterministically deduplicated across packages",
    );
    assert.equal(observations[0].printing.rarity.raw, "R");
    assert.equal(observations[0].printing.rarity.normalized, "rare");
    assert.match(
      observations[0].identity_evidence.artwork_fingerprint,
      /^official-artwork:/u,
    );
    assert.match(
      observations[0].identity_evidence.printed_fields_digest,
      /^printed-material:/u,
    );
    assert.throws(
      () => current.parseBytes(
        new TextEncoder().encode(
          `<html>${officialPublisherPayloadScript(
            lineage,
            "packages",
            complete,
          )}</html>`,
        ),
        {
          mediaType: "text/html",
          url: current.requestUrlForSurface("packages"),
          requestId: `${lineage}:packages`,
        },
      ),
      /Gundam catalogue facts require an exact package leaf/iu,
    );

    const conflicting = structuredClone(complete);
    conflicting.result.partitions[1].entries[0].number = "GD99-999";
    assert.throws(
      () => parseRegisteredSurface(current, "packages", conflicting),
      /full locator.*conflict/iu,
    );
    const unknownRarity = structuredClone(complete);
    unknownRarity.card_details[0].printing.rarity = "Experimental Rare";
    assert.throws(
      () => parseRegisteredSurface(current, "packages", unknownRarity),
      /Gundam rarity.*Experimental Rare/iu,
    );
  }
});

test("issue-58 Gundam adapters parse the retained compound policy into explicit unresolved rules", () => {
  const openPredicateReason =
    'The published description "a Unit card that is Lv.2 with cost 1, 2 AP, and 2 HP, and without effects" includes future printings; its complete matching-card scope and effective interval are not stated.';
  for (const descriptor of [
    {
      adapter: "gundam-en-asia@7",
      slug: "gundam-en-asia-policy-detail",
      lineage: "gundam-en-asia",
      region: "EN-ASIA",
    },
    {
      adapter: "gundam-en-us@7",
      slug: "gundam-en-us-policy-detail",
      lineage: "gundam-en-us",
      region: "EN-US",
    },
  ]) {
    const adapter = requiredSourceAdapter(descriptor.adapter);
    assert.equal(
      adapter.requestUrlForSurface("legality"),
      retainedOfficialSourceFixture(descriptor.slug).metadata.source_url,
    );
    const rules = retainedLegalityRules(
      adapter,
      "legality",
      descriptor.slug,
      { requestId: `${descriptor.lineage}:legality` },
    );
    assert.equal(rules.length, 5);
    assert.ok(rules.every((rule) =>
      rule.region === descriptor.region &&
      rule.effective_from === null &&
      rule.effect.type === "unresolved" &&
      rule.unresolved_scope.dimensions.includes("effective_interval")
    ));
    assert.deepEqual(
      rules.slice(0, 4).map((rule) => rule.card_numbers),
      [
        ["GD01-020"],
        ["ST02-016"],
        ["ST01-010", "ST05-010"],
        ["GD01-008", "GD05-015"],
      ],
    );
    const openPredicate = rules[4];
    assert.equal(openPredicate.id, "01_279-current-open-predicate");
    assert.deepEqual(openPredicate.unresolved_scope, {
      dimensions: ["effective_interval", "target_scope"],
    });
    assert.equal(openPredicate.card_numbers.length, 20);
    assert.equal(openPredicate.card_numbers[0], "GD01-035");
    assert.equal(openPredicate.card_numbers.at(-1), "ST10-005");
    assert.equal(openPredicate.effect.reason, openPredicateReason);
    assert.match(
      openPredicate.official_wording,
      /^All combinations of cards that match the above description/u,
    );
  }
});

test("retained Gundam package snapshots close publisher totals and dedupe full locators across the request plan", () => {
  for (const { lineage, packageValue } of [
    { lineage: "gundam-en-asia", packageValue: "619102" },
    { lineage: "gundam-en-us", packageValue: "616102" },
  ]) {
    const adapter = requiredSourceAdapter(`${lineage}@7`);
    const rootUrl = adapter.requestUrlForSurface("packages");
    const fixturePrefix = `../../acceptance/fixtures/retained-official-source/${lineage}-card-list`;
    const rootBytes = readFileSync(new URL(
      `${fixturePrefix}-root-live-fragment.html`,
      import.meta.url,
    ));
    const packageBytes = readFileSync(new URL(
      `${fixturePrefix}-package-live-fragment.html`,
      import.meta.url,
    ));
    const rootContext = {
      mediaType: "text/html; charset=UTF-8",
      url: rootUrl,
      requestId: `${lineage}:packages`,
    };
    const packageContext = {
      mediaType: "text/html; charset=UTF-8",
      url: `${rootUrl}?package=${packageValue}`,
      requestId: `${lineage}:listing:${"b".repeat(64)}`,
    };

    const rootRequests = adapter.discoverRequests(rootBytes, rootContext);
    assert.deepEqual(
      rootRequests.filter(({ role }) => role === "listing")
        .map(({ url }) => new URL(url).searchParams.get("package")),
      lineage === "gundam-en-asia"
        ? ["619101", "619102"]
        : ["616101", "616102"],
    );
    const packageRequests = adapter.discoverRequests(
      packageBytes,
      packageContext,
    );
    const allDetailUrls = [...rootRequests, ...packageRequests]
      .filter(({ role }) => role === "detail")
      .map(({ url }) => url);
    assert.equal(allDetailUrls.length, 4);
    assert.equal(new Set(allDetailUrls).size, 2);

    for (const [bytes, context] of [
      [rootBytes, rootContext],
      [packageBytes, packageContext],
    ]) {
      const [coverage] = adapter.parseBytes(bytes, context);
      assert.deepEqual(coverage.completeness, {
        declared_record_count: 2,
        parsed_record_count: 2,
        required_surfaces_complete: true,
        partitions_complete: true,
        structurally_complete: true,
      });
    }

    const packageHtml = packageBytes.toString("utf8");
    const nonterminalHtml = packageHtml
      .replace('<span class="num">2</span>', '<span class="num">4</span>')
      .replace(
        '<div class="pager"></div>',
        `<div class="pager"><a href="?package=${packageValue}&amp;page=2">2</a></div>`,
      );
    const [nonterminalCoverage] = adapter.parseBytes(
      new TextEncoder().encode(nonterminalHtml),
      packageContext,
    );
    assert.deepEqual(nonterminalCoverage.completeness, {
      declared_record_count: 4,
      parsed_record_count: 2,
      required_surfaces_complete: false,
      partitions_complete: false,
      structurally_complete: true,
    });
    const nonterminalRequests = adapter.discoverRequests(
      new TextEncoder().encode(nonterminalHtml),
      packageContext,
    );
    assert.deepEqual(
      nonterminalRequests
        .filter(({ role }) => role === "detail")
        .map(({ url }) => url),
      [
        `${new URL("detail.php", rootUrl)}?detailSearch=GD02-001`,
        `${new URL("detail.php", rootUrl)}?detailSearch=GD02-001_p1`,
      ],
    );
    assert.equal(
      nonterminalRequests.some(({ role, url }) =>
        role === "listing" &&
        url === `${rootUrl}?package=${packageValue}&page=2`
      ),
      true,
    );
    assert.throws(
      () => adapter.parseBytes(
        new TextEncoder().encode(
          packageHtml.replace('value="' + packageValue + '"', 'value="wrong"'),
        ),
        packageContext,
      ),
      /selected package.*request/iu,
    );
    assert.throws(
      () => adapter.parseBytes(
        new TextEncoder().encode(
          packageHtml.replace('<span class="num">2</span>', '<span class="num">3</span>'),
        ),
        packageContext,
      ),
      /publisher total.*full locators/iu,
    );
    const pagedBytes = new TextEncoder().encode(packageHtml.replace(
      "</section>", '<input type="hidden" name="page" value="2"></section>',
    ));
    assert.doesNotThrow(
      () => adapter.parseBytes(pagedBytes, {
        ...packageContext,
        url: `${packageContext.url}&page=2`,
      }),
    );
    assert.throws(
      () => adapter.parseBytes(pagedBytes, {
        ...packageContext,
        url: `${packageContext.url}&page=3`,
      }),
      /selected page.*request/iu,
    );
    const partialTerminalBytes = new TextEncoder().encode(
      packageHtml
        .replace('<span class="num">2</span>', '<span class="num">4</span>')
        .replace(
          "</section>",
          '<input type="hidden" name="page" value="2"></section>',
        ),
    );
    const [partialTerminalCoverage] = adapter.parseBytes(
      partialTerminalBytes,
      { ...packageContext, url: `${packageContext.url}&page=2` },
    );
    assert.equal(
      partialTerminalCoverage.completeness.required_surfaces_complete,
      false,
    );
  }
});

test("digest-verified unchanged Gundam publisher listing bytes close their exact result", () => {
  const fixture = retainedOfficialSourceFixture(
    "gundam-en-asia-card-list-complete-live",
  );
  const adapter = requiredSourceAdapter("gundam-en-asia@7");
  const context = {
    mediaType: fixture.metadata.content_type,
    url: fixture.metadata.source_url,
    requestId: `gundam-en-asia:listing:${"d".repeat(64)}`,
  };
  const [coverage] = adapter.parseBytes(fixture.bytes, context);
  assert.deepEqual(coverage.completeness, {
    declared_record_count: 187,
    parsed_record_count: 187,
    required_surfaces_complete: true,
    partitions_complete: true,
    structurally_complete: true,
  });
  assert.equal(
    adapter.discoverRequests(fixture.bytes, context)
      .filter(({ role }) => role === "detail").length,
    187,
  );
});

test("retained Gundam detail snapshots bind base and alternate art to full locators", () => {
  for (const { lineage, locale } of [
    { lineage: "gundam-en-asia", locale: "asia-en" },
    { lineage: "gundam-en-us", locale: "en" },
  ]) {
    const adapter = requiredSourceAdapter(`${lineage}@7`);
    const observations = ["base", "p2"].map((variant) => {
      const suffix = variant === "base" ? "" : "_p2";
      const bytes = readFileSync(new URL(
        `../../acceptance/fixtures/retained-official-source/${lineage}-card-detail-${variant}-live-fragment.html`,
        import.meta.url,
      ));
      const detailContext = {
        mediaType: "text/html; charset=UTF-8",
        url:
          `https://www.gundam-gcg.com/${locale}/cards/detail.php?detailSearch=GD02-038${suffix}`,
        requestId:
          `${lineage}:detail:${(variant === "base" ? "1" : "2").repeat(64)}`,
      };
      assert.equal(
        adapter.discoverRequests(bytes, detailContext)
          .filter(({ role }) => role === "image").length,
        1,
      );
      return adapter.parseBytes(bytes, detailContext)[0];
    });
    assert.deepEqual(
      observations.map((observation) => ({
        card_number: observation.card.official_identity.value,
        locator: observation.identity_evidence.locator,
        variant: observation.identity_evidence.variant_key,
        treatment: observation.identity_evidence.treatment,
        rarity: observation.printing.rarity,
        alternate_art:
          observation.printing.game_data.attributes.alternate_art,
      })),
      [
        {
          card_number: "GD02-038",
          locator: "GD02-038",
          variant: "base",
          treatment: "standard",
          rarity: { raw: "LR", normalized: "legend-rare" },
          alternate_art: false,
        },
        {
          card_number: "GD02-038",
          locator: "GD02-038_p2",
          variant: "_p2",
          treatment: "alternate",
          rarity: { raw: "LR ++", normalized: "legend-rare" },
          alternate_art: true,
        },
      ],
    );
    assert.notEqual(
      observations[0].identity_evidence.artwork_fingerprint,
      observations[1].identity_evidence.artwork_fingerprint,
    );
    assert.deepEqual(observations[1].card.game_data.attributes, {
      card_type: "unit",
      colours: ["red"],
      level: 7,
      cost: 5,
      block_icon: "1",
      effect_text: "【Deploy】Official alternate effect.",
      zone: "Space Earth",
      traits: ["(Clan)"],
      link_condition: "[Amate Yuzuriha (Machu)]",
      ap: 5,
      hp: 4,
      series_titles: ["Mobile Suit Gundam GQuuuuuuX"],
    });
  }
});

test("digest-verified unchanged Gundam publisher dash remains raw and normalizes", () => {
  const fixture = retainedOfficialSourceFixture(
    "gundam-en-asia-card-detail-dash-live",
  );
  const adapter = requiredSourceAdapter("gundam-en-asia@7");
  const [observation] = adapter.parseBytes(fixture.bytes, {
    mediaType: fixture.metadata.content_type,
    url: fixture.metadata.source_url,
    requestId: `gundam-en-asia:detail:${"4".repeat(64)}`,
  });
  assert.equal(
    observation.card.game_data.attributes.link_condition,
    null,
  );
  assert.equal(
    observation.source_sidecar.raw.official_surfaces[0].document.Link,
    "-",
  );
});

test("synthetic Gundam dash-glyph variants normalize without changing raw evidence", () => {
  for (const { lineage, locale } of [
    { lineage: "gundam-en-asia", locale: "asia-en" },
    { lineage: "gundam-en-us", locale: "en" },
  ]) {
    const adapter = requiredSourceAdapter(`${lineage}@7`);
    const syntheticPlaceholderBytes = new TextEncoder().encode(
      readFileSync(new URL(
        `../../acceptance/fixtures/retained-official-source/${lineage}-card-detail-base-live-fragment.html`,
        import.meta.url,
      )).toString("utf8")
        .replace('<div class="blockIcon">1</div>', '<div class="blockIcon">-</div>')
        .replace('<dt>Zone</dt><dd>Space Earth</dd>', '<dt>Zone</dt><dd>—</dd>')
        .replace(
          '<dt>Link</dt><dd>[Amate Yuzuriha (Machu)]</dd>',
          '<dt>Link</dt><dd>–</dd>',
        ),
    );
    const [placeholderObservation] = adapter.parseBytes(
      syntheticPlaceholderBytes,
      {
      mediaType: "text/html; charset=UTF-8",
      url:
        `https://www.gundam-gcg.com/${locale}/cards/detail.php?detailSearch=GD02-038`,
      requestId: `${lineage}:detail:${"3".repeat(64)}`,
      },
    );
    assert.deepEqual(
      {
        block_icon: placeholderObservation.card.game_data.attributes.block_icon,
        zone: placeholderObservation.card.game_data.attributes.zone,
        link_condition:
          placeholderObservation.card.game_data.attributes.link_condition,
      },
      { block_icon: null, zone: null, link_condition: null },
    );
    const [syntheticRawSurface] =
      placeholderObservation.source_sidecar.raw.official_surfaces;
    assert.deepEqual(
      {
        block_icon: syntheticRawSurface.document["Block icon"],
        zone: syntheticRawSurface.document.Zone,
        link_condition: syntheticRawSurface.document.Link,
      },
      { block_icon: "-", zone: "—", link_condition: "–" },
    );
  }
});

test("restructured Gundam card search roots retain their empty state and every package option", () => {
  for (const lineage of ["gundam-en-asia", "gundam-en-us"]) {
    const adapter = requiredSourceAdapter(`${lineage}@7`);
    const url = adapter.requestUrlForSurface("packages");
    const slug = `${lineage}-restructured-card-search`;
    const { observations } = retainedRestructuredParse(adapter, slug, {
      url,
      requestId: `${lineage}:packages`,
    });
    assert.equal(observations.length, 1, lineage);
    const document =
      observations[0].source_sidecar.raw.official_surfaces[0].document;
    assert.deepEqual(Object.keys(document).sort(), [
      "empty_search_state",
      "package_options",
      "source_lineage",
      "surface",
      "url",
    ], lineage);
    assert.equal(document.source_lineage, lineage);
    assert.equal(document.surface, "packages");
    assert.equal(document.url, url);
    assert.equal(
      document.empty_search_state,
      "Please specify your search criteria.",
      lineage,
    );
    assert.equal(document.package_options.length, 21, lineage);
    assert.deepEqual(
      document.package_options,
      [...document.package_options].sort(),
      lineage,
    );
    assert.deepEqual(observations[0].completeness, {
      structurally_complete: true,
      required_surfaces_complete: true,
      partitions_complete: true,
      declared_record_count: 21,
      parsed_record_count: 21,
    }, lineage);

    const listings = retainedRestructuredRequests(adapter, slug, {
      url,
      requestId: `${lineage}:packages`,
    }).filter(({ role }) => role === "listing");
    assert.deepEqual(
      listings.map(({ url: listingUrl }) => listingUrl),
      document.package_options.map((option) => `${url}?package=${option}`),
      lineage,
    );
  }
});

test("restructured Gundam news discovery pins the errata listing subcategory tab", () => {
  for (const lineage of ["gundam-en-asia", "gundam-en-us"]) {
    const adapter = requiredSourceAdapter(`${lineage}@7`);
    const locale = lineage === "gundam-en-asia" ? "asia-en" : "en";
    const { observations } = retainedRestructuredParse(
      adapter,
      `${lineage}-news-hub`,
      {
        url: `https://www.gundam-gcg.com/${locale}/news/`,
        requestId: `${lineage}:listing:news:${restructuredStageDigest}`,
      },
    );
    assert.deepEqual(stageRecordSummaries(observations), [
      {
        id: `${lineage}:errata`,
        surface: "errata",
        url: adapter.requestUrlForSurface("errata"),
      },
    ], lineage);
  }
});

test("the retained Gundam errata listing schedules its article and remaining pages", () => {
  const adapter = requiredSourceAdapter("gundam-en-asia@7");
  const url = adapter.requestUrlForSurface("errata");
  const { fixture } = retainedRestructuredParse(
    adapter,
    "gundam-en-asia-errata-listing",
    { url, requestId: "gundam-en-asia:errata" },
  );
  assert.equal(fixture.metadata.source_url, url);
  const staged = retainedRestructuredRequests(
    adapter,
    "gundam-en-asia-errata-listing",
    { url, requestId: "gundam-en-asia:errata" },
  );
  assert.deepEqual(
    staged.filter(({ role }) => role === "detail").map(
      ({ url: detailUrl }) => detailUrl,
    ),
    ["https://www.gundam-gcg.com/asia-en/news/01_236.html"],
  );
  assert.deepEqual(
    staged.filter(({ role }) => role === "listing").map(
      ({ url: listingUrl }) => listingUrl,
    ),
    [2, 3, 4].map((page) =>
      `https://www.gundam-gcg.com/asia-en/news/?subcategory=news&tag=all&page=${page}`
    ),
  );
});

function mutatedProductDetail(sourceLineage, slug, from, to, adapter) {
  const resolved = adapter ?? activeProductionAdapter(sourceLineage);
  const fixture = retainedOfficialSourceFixture(slug);
  const html = fixture.bytes.toString("utf8");
  assert.ok(html.includes(from), `${slug} must retain ${from}`);
  return () =>
    resolved.parseBytes(
      new TextEncoder().encode(html.replace(from, to)),
      {
        mediaType: "text/html",
        url: fixture.metadata.source_url,
        requestId: `${sourceLineage}:product_detail:${restructuredStageDigest}`,
      },
    );
}

test("retained live Gundam product pages promote every titled Product from its heading contract", () => {
  const booster = retainedProductDetail(
    "gundam-en-asia",
    "gundam-en-asia-product-booster",
  );
  assert.deepEqual(booster.catalogue.products, [{
    reference: { kind: "official_code", value: "GD05" },
    official_code: "GD05",
    name: "Freedom Ascension [GD05]",
    releases: [{
      event_key: "product-release:GD05",
      region: "EN-ASIA",
      date: { precision: "day", value: "2026-07-25" },
      status: null,
    }],
  }]);
  assert.deepEqual(booster.catalogue.distribution_contexts, []);
  assert.equal(booster.document.document_title, "Freedom Ascension [GD05]");

  // A card-bearing box is an ordinary Product, not an accessory.
  const deckBuildBox = retainedProductDetail(
    "gundam-en-asia",
    "gundam-en-asia-product-deck-build-box",
  );
  assert.deepEqual(deckBuildBox.catalogue.products, [{
    reference: { kind: "official_code", value: "SC01" },
    official_code: "SC01",
    name: "Deck Build Box Freedom Ascension [SC01]",
    releases: [{
      event_key: "product-release:SC01",
      region: "EN-ASIA",
      date: { precision: "day", value: "2026-07-25" },
      status: null,
    }],
  }]);
  assert.deepEqual(deckBuildBox.catalogue.distribution_contexts, []);
});

test("a retained live Gundam set without a bracketed code keeps name identity and its dotted release date", () => {
  const { catalogue, fixture } = retainedProductDetail(
    "gundam-en-asia",
    "gundam-en-asia-product-anniversary-set",
  );
  // The publisher prints the shorthand "2026.7.27" on this page.
  assert.ok(fixture.bytes.toString("utf8").includes("2026.7.27"));
  const [product] = catalogue.products;
  assert.equal(catalogue.products.length, 1);
  assert.equal(product.official_code, null);
  assert.deepEqual(product.reference, {
    kind: "name",
    value: "GUNDAM CARD GAME 1st Anniversary Set",
  });
  assert.equal(product.name, "GUNDAM CARD GAME 1st Anniversary Set");
  assert.deepEqual(product.releases[0].date, {
    precision: "day",
    value: "2026-07-27",
  });
  assert.equal(product.releases[0].region, "EN-ASIA");
  assert.match(
    product.releases[0].event_key,
    /^product-release:name-[0-9a-f]+-[0-9a-f]{16}$/u,
  );
});

test("retained live Gundam accessory pages retain non-card evidence in both locales", () => {
  for (const lineage of ["gundam-en-asia", "gundam-en-us"]) {
    retainedAccessoryContext(
      lineage,
      `${lineage}-product-card-case`,
      "Official Card Case Set 02",
    );
  }
  retainedAccessoryContext(
    "gundam-en-us",
    "gundam-en-us-product-playmat",
    "Official Playmat & Card Set — Mobile Suit Gundam 00 —",
  );
});

test("live Product detail fails closed without its publisher title suffix or matching Gundam heading", () => {
  assert.throws(
    mutatedProductDetail(
      "one-piece-en",
      "one-piece-en-product-card-collection",
      " | ONE PIECE CARD GAME - Official Web Site</title>",
      "</title>",
    ),
    /one-piece-en Product detail is missing its official title\./u,
  );
  assert.throws(
    mutatedProductDetail(
      "gundam-en-asia",
      "gundam-en-asia-product-booster",
      " | GUNDAM CARD GAME Official Website</title>",
      "</title>",
    ),
    /gundam-en-asia Product detail is missing its official title\./u,
  );
  assert.throws(
    mutatedProductDetail(
      "gundam-en-asia",
      "gundam-en-asia-product-booster",
      '<h2 class="mvColTitle">Freedom Ascension [GD05]</h2>',
      '<h2 class="mvColTitle">Freedom Ascension</h2>',
    ),
    /gundam-en-asia Product detail heading does not match its official title\./u,
  );
});
