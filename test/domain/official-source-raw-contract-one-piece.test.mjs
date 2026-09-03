import { test } from "vitest";
import assert from "node:assert/strict";
import {
  officialSourceDiscoveryRequests,
} from "../../src/catalogue/product-release-source-adapters.ts";
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
  registeredProductionAdapters,
  retainedOfficialSourceFixture,
  retainedLegalityRules,
  restructuredStageDigest,
  retainedRestructuredParse,
  stageRecordSummaries,
  activeProductionAdapter,
  retainedProductDetail,
  retainedAccessoryContext,
  rawSurfacePayload,
  parseRegisteredSurface,
} from "./official-source-raw-contract-shared.mjs";

test("retained live One Piece policy bytes publish the complete current active list", () => {
  const adapter = requiredSourceAdapter("one-piece-en@6");
  const rules = retainedLegalityRules(
    adapter,
    "restrictions",
    "one-piece-en-policy",
  );
  assert.deepEqual(
    rules.map((rule) => ({
      cards: rule.card_numbers,
      effect: rule.effect,
      effective_from: rule.effective_from,
    })),
    [
      { cards: ["OP06-047"], effect: { type: "ban" }, effective_from: "2026-04-10" },
      { cards: ["OP03-040"], effect: { type: "ban" }, effective_from: "2026-04-10" },
      { cards: ["OP06-086"], effect: { type: "ban" }, effective_from: "2026-04-10" },
      { cards: ["ST10-001"], effect: { type: "ban" }, effective_from: "2026-04-10" },
      { cards: ["OP06-116"], effect: { type: "ban" }, effective_from: "2026-04-10" },
      {
        cards: ["OP07-115"],
        effect: { type: "prohibited_combination", with_card_numbers: ["EB04-058"] },
        effective_from: "2026-04-10",
      },
      {
        cards: ["OP11-040"],
        effect: { type: "prohibited_combination", with_card_numbers: ["OP11-067"] },
        effective_from: "2026-04-10",
      },
      {
        cards: ["OP11-040"],
        effect: { type: "prohibited_combination", with_card_numbers: ["OP08-069"] },
        effective_from: "2026-04-10",
      },
    ],
  );
});

test("the issue-58 One Piece don-rules contract retains the live hub as coverage without DON payload", () => {
  const adapter = requiredSourceAdapter("one-piece-en@6");
  const fixture = retainedOfficialSourceFixture("one-piece-en-don-rules-hub");
  const observations = adapter.parseBytes(fixture.bytes, {
    mediaType: fixture.metadata.content_type,
    url: fixture.metadata.source_url,
    requestId: "one-piece-en:don-rules",
  });
  assert.equal(observations.length, 2);
  const [coverage, legality] = observations;
  assert.deepEqual(coverage.completeness, {
    structurally_complete: true,
    required_surfaces_complete: true,
    partitions_complete: true,
    declared_record_count: 76,
    parsed_record_count: 76,
  });
  const retained = coverage.source_sidecar.raw.official_surfaces[0].document;
  assert.equal(
    retained.document_title,
    "RULES｜ONE PIECE CARD GAME - Official Web Site",
  );
  for (const pinned of [
    "https://en.onepiece-cardgame.com/news/restriction.html",
    "https://en.onepiece-cardgame.com/topics/013.php",
    "https://en.onepiece-cardgame.com/rules/errata_card/",
  ]) {
    assert.ok(
      retained.navigation_links.some(({ url }) => url === pinned),
      `retained hub evidence keeps ${pinned}`,
    );
  }
  assert.equal(legality.observation_type, "legality_rules");
  assert.deepEqual(legality.legality_rules, []);
  assert.equal(legality.completeness.declared_record_count, 0);
});

test("retained One Piece and Digimon policies reject unconsumed event scope while allowing text-free framing", () => {
  const cases = [
    {
      adapter: "one-piece-en@6",
      slug: "one-piece-en-policy",
      requestId: "one-piece-en:restrictions",
      anchor: "<h4>Banned Cards</h4>",
    },
    {
      adapter: "digimon-en@7",
      slug: "digimon-en-policy",
      requestId: "digimon-en:restrictions-current",
      anchor:
        '<h4 class="subTit txtNormal">List of Currently Affected Cards</h4>',
    },
  ];
  for (const descriptor of cases) {
    const adapter = requiredSourceAdapter(descriptor.adapter);
    const fixture = retainedOfficialSourceFixture(descriptor.slug);
    const source = fixture.bytes.toString("utf8");
    const parse = (html) => adapter.parseBytes(Buffer.from(html), {
      mediaType: fixture.metadata.content_type,
      url: fixture.metadata.source_url,
      requestId: descriptor.requestId,
    });
    assert.throws(
      () => parse(source.replace(
        descriptor.anchor,
        `${descriptor.anchor}<p>These restrictions apply at Championship events.</p>`,
      )),
      /unconsumed|exact|semantics|structure/iu,
      descriptor.adapter,
    );
    assert.doesNotThrow(() => parse(source.replace(
      descriptor.anchor,
      `<div class="publisher-frame"></div>${descriptor.anchor}`,
    )));
  }
});

test("One Piece parser-failure markers survive retained discovery, staged listing, and final surface transport", async () => {
  const adapter = requiredSourceAdapter("one-piece-en@6");
  const url = "https://en.onepiece-cardgame.com/cardlist/";
  // The retained discovery root now lives behind the publisher's series
  // redirect; staged listing requests must never be answered with it.
  const rootUrl = "https://en.onepiece-cardgame.com/cardlist/?series=569116";
  for (const failure of ["cap", "pagination"]) {
    const marker = `card-keepr-acceptance-parser/${failure}`;
    const responseForRole = (role) => syntheticOfficialSource.fetch(
      new Request(role === null ? rootUrl : url, {
        headers: {
          "user-agent": role === null
            ? marker
            : `${marker}; request-role=${role}`,
        },
      }),
    );
    const rootBytes = new Uint8Array(
      await (await responseForRole(null)).arrayBuffer(),
    );
    const listingResponse = await responseForRole("listing");
    const listingBytes = new Uint8Array(await listingResponse.arrayBuffer());
    assert.notDeepEqual(
      listingBytes,
      rootBytes,
      "the listing request must not be routed back to retained root bytes",
    );
    assert.deepEqual(
      adapter.parseBytes(listingBytes, {
        mediaType: listingResponse.headers.get("content-type"),
        url,
        requestId: `one-piece-en:listing:cards:${"a".repeat(64)}`,
      }).flatMap(({ records }) => records ?? []).map(({ surface }) => surface),
      ["card-list"],
    );
    const surfaceResponse = await responseForRole("surface");
    const surfaceBytes = new Uint8Array(await surfaceResponse.arrayBuffer());
    assert.throws(
      () => adapter.parseBytes(surfaceBytes, {
        mediaType: surfaceResponse.headers.get("content-type"),
        url,
        requestId: "one-piece-en:card-list",
      }),
      failure === "cap"
        ? /result-cap evidence does not prove complete coverage/iu
        : /pagination evidence does not prove complete partitions/iu,
    );
  }
});

test("One Piece release publications fail closed on unmodelled conditional legality wording", () => {
  const adapter = requiredSourceAdapter("one-piece-en@6");
  for (const publication of [
    "<article>OP01-001 may not be included unless your Leader is OP01-999.</article>",
    `<article>Official product entry</article>
     <span>OP01-001 may not be included unless your Leader is OP01-999.</span>`,
  ]) {
    assert.throws(
      () => adapter.parseBytes(
        new TextEncoder().encode(`
          <html><title>BANDAI ONE PIECE CARD PRODUCT RELEASE publication</title>
            ${publication}
          </html>
        `),
        {
          mediaType: "text/html; charset=utf-8",
          url: adapter.requestUrlForSurface("releases"),
          requestId: "one-piece-en:releases",
        },
      ),
      /non-empty Legality data without an exact, complete Legality Rule parser/iu,
    );
  }
});

test("the versioned One Piece release surface emits its exact release-timing rule beside Release evidence", () => {
  const current = requiredSourceAdapter("one-piece-en@6");
  const payload = rawSurfacePayload("one-piece-en", "releases");
  payload.release_timing_entries = [{
    notice_no: "OP-RELEASE-2026-001",
    published_text:
      "OP99-001 becomes legal for standard tournament play on 2026-09-04.",
    territory: "EN-OCEANIA",
    format_name: "standard",
    event_class: null,
    start_date: "2026-08-01",
    end_date: null,
    card_numbers: ["OP99-001"],
    restriction_code: "release_timing",
    legal_from: "2026-09-04",
  }];
  const observations = parseRegisteredSurface(current, "releases", payload);
  assert.ok(observations.some(({ product_release_catalogue }) =>
    product_release_catalogue?.products?.some(({ releases }) =>
      releases.length > 0
    )
  ));
  const legality = observations.find(
    ({ observation_type }) => observation_type === "legality_rules",
  );
  assert.deepEqual(legality.legality_rules, [{
    id: "OP-RELEASE-2026-001",
    game: "one-piece",
    region: "EN-OCEANIA",
    format: "standard",
    event_tier: null,
    effective_from: "2026-08-01",
    effective_until: null,
    unresolved_scope: null,
    card_numbers: ["OP99-001"],
    official_wording:
      "OP99-001 becomes legal for standard tournament play on 2026-09-04.",
    effect: { type: "release_timing", legal_from: "2026-09-04" },
    representable: true,
  }]);
});

test("one identical ordinary One Piece Product document is valid for Product and Release roles", () => {
  const adapter = requiredSourceAdapter("one-piece-en@6");
  const bytes = Buffer.from(
    `<html><title>BANDAI ONE PIECE CARD PRODUCTS</title>
      <main><p>0 records</p><article data-publication-empty="true">No published entries.</article></main>
    </html>`,
    "utf8",
  );
  for (const surface of ["products", "releases"]) {
    const observations = adapter.parseBytes(bytes, {
      mediaType: "text/html; charset=utf-8",
      url: "https://en.onepiece-cardgame.com/products/",
      requestId: `one-piece-en:${surface}`,
    });
    assert.ok(observations.length >= 1, surface);
  }
});

test("One Piece publisher data retains an explicit first Printing identity", () => {
  const adapter = registeredProductionAdapters().find(
    ({ sourceLineage }) => sourceLineage === "one-piece-en",
  );
  const payload = officialRawSurfacePayload("/one-piece-en/card-list");
  payload.card_pages.forEach((card) => {
    delete card.artwork_fingerprint;
    delete card.printed_fields_digest;
  });
  const observations = adapter.parseBytes(
    new TextEncoder().encode(
      `<html>${officialPublisherPayloadScript(
        "one-piece-en",
        "card-list",
        payload,
      )}</html>`,
    ),
    {
      mediaType: "text/html; charset=utf-8",
      url: adapter.requestUrlForSurface("card-list"),
      requestId: "one-piece-en:card-list",
    },
  );
  const observation = observations.find(
    ({ card }) => card?.official_identity?.value === "OP99-001",
  );
  assert.ok(observation?.printing);
  assert.equal(
    observation.identity_evidence.artwork_fingerprint,
    'official-artwork:{"official_card_identity":"OP99-001","roles":["front"],"artwork_id":null}',
  );
  assert.equal(observation.identity_evidence.locator, "/cards/OP99-001");
  assert.equal(observation.identity_evidence.treatment, null);
  assert.match(
    observation.identity_evidence.printed_fields_digest,
    /printed-material:.*OP99-001/u,
  );
});

test("the expanded One Piece adapter emits exact typed Errata and rejects unrepresentable entries", () => {
  const adapter = requiredSourceAdapter("one-piece-en@6");
  const payload = officialRawSurfacePayload("/one-piece-en/errata");
  payload.declared_record_count = 1;
  payload.partition.total = 1;
  payload.entries = [{
    notice_id: "errata-op31-001",
    card_number: "OP31-001",
    card_name: "Complete One Piece Leader",
    published_on: "2026-08-01",
    effective_from: null,
    before_text: "Give up to 1 rested DON!! card to this Leader.",
    after_text: "Give up to 2 rested DON!! cards to this Leader.",
    note: "This correction applies in every game format.",
    applies_to_parallel_printings: true,
    image_url:
      "https://en.onepiece-cardgame.com/images/cardlist/card/OP31-001.png",
  }];
  const observations = adapter.parseBytes(
    new TextEncoder().encode(`<html>${officialPublisherPayloadScript(
      "one-piece-en",
      "errata",
      payload,
    )}</html>`),
    {
      mediaType: "text/html; charset=utf-8",
      url: adapter.requestUrlForSurface("errata"),
      requestId: "one-piece-en:errata",
    },
  );
  const erratum = observations.find(({ kind }) => kind === "official_erratum");
  assert.deepEqual(erratum, {
    kind: "official_erratum",
    game: "one-piece",
    target: {
      type: "card",
      official_identity: { kind: "card_number", value: "OP31-001" },
    },
    published_on: "2026-08-01",
    effective_from: null,
    observed_printed_rules_text:
      "Give up to 1 rested DON!! card to this Leader.",
    corrected_rules_text:
      "Give up to 2 rested DON!! cards to this Leader.",
    official_wording:
      "Note: This correction applies in every game format.\n" +
      "Before: Give up to 1 rested DON!! card to this Leader.\n" +
      "After: Give up to 2 rested DON!! cards to this Leader.",
    applies_to_parallel_printings: true,
    source: {
      fragment: "#errata-op31-001",
      display_name: "OP31-001 Complete One Piece Leader",
      image_url:
        "https://en.onepiece-cardgame.com/images/cardlist/card/OP31-001.png",
    },
    completeness: {
      structurally_complete: true,
      required_surfaces_complete: true,
      partitions_complete: true,
      declared_record_count: 1,
      parsed_record_count: 1,
    },
  });

  const arbitrary = structuredClone(payload);
  arbitrary.entries = [{ publisher_note: "Apply an unknown correction." }];
  assert.throws(
    () => adapter.parseBytes(
      new TextEncoder().encode(`<html>${officialPublisherPayloadScript(
        "one-piece-en",
        "errata",
        arbitrary,
      )}</html>`),
      {
        mediaType: "text/html; charset=utf-8",
        url: adapter.requestUrlForSurface("errata"),
        requestId: "one-piece-en:errata",
      },
    ),
    /Erratum.*undeclared field|Erratum.*publisher_note/iu,
  );
});

test("the expanded One Piece adapter rejects identity digests nested under Printing", () => {
  const adapter = requiredSourceAdapter("one-piece-en@6");
  for (const field of ["artwork_fingerprint", "printed_fields_digest"]) {
    const payload = officialRawSurfacePayload("/one-piece-en/card-list");
    for (const card of payload.card_pages) {
      delete card.artwork_fingerprint;
      delete card.printed_fields_digest;
    }
    payload.card_pages[0].printing[field] = `publisher-supplied-${field}`;
    assert.throws(
      () => adapter.parseBytes(
        new TextEncoder().encode(`<html>${officialPublisherPayloadScript(
          "one-piece-en",
          "card-list",
          payload,
        )}</html>`),
        {
          mediaType: "text/html; charset=utf-8",
          url: adapter.requestUrlForSurface("card-list"),
          requestId: "one-piece-en:card-list",
        },
      ),
      new RegExp(`identity digest|${field}`, "iu"),
    );
  }
});

test("the expanded One Piece adapter closes the nested DON Card policy schema", () => {
  const adapter = requiredSourceAdapter("one-piece-en@6");
  const payload = officialRawSurfacePayload("/one-piece-en/don-rules");
  payload.don_card = {
    functional_designation: "DON!!",
    name: "DON!! Card",
    Category: "DON!! Card",
    Effect: "A rules-level resource Card.",
    publisher_note: "Apply an unknown DON rule.",
  };
  assert.throws(
    () => adapter.parseBytes(
      new TextEncoder().encode(`<html>${officialPublisherPayloadScript(
        "one-piece-en",
        "don-rules",
        payload,
      )}</html>`),
      {
        mediaType: "text/html; charset=utf-8",
        url: adapter.requestUrlForSurface("don-rules"),
        requestId: "one-piece-en:don-rules",
      },
    ),
    /DON.*undeclared field|DON.*publisher_note/iu,
  );
});

test("the restructured One Piece discovery root repeats every publisher navigation link", () => {
  const adapter = requiredSourceAdapter("one-piece-en@6");
  const request = officialSourceDiscoveryRequests("one-piece-en")[0];
  const fixture = retainedOfficialSourceFixture(
    "one-piece-en-restructured-discovery",
  );
  assert.equal(fixture.metadata.source_url, request.url);
  const html = fixture.bytes.toString("utf8");
  const navigationAnchor = (label) =>
    `<span class="menuColListLinkTit">${label}</span>`;
  for (const label of ["FIND CARDS", "ALL PRODUCTS", "RULES"]) {
    assert.equal(
      html.split(navigationAnchor(label)).length - 1,
      2,
      `${label} must be retained in both the header and the footer`,
    );
  }
  const records = stageRecordSummaries(
    adapter.parseBytes(fixture.bytes, {
      mediaType: fixture.metadata.content_type,
      url: request.url,
      requestId: request.id,
    }),
  );
  assert.deepEqual(records, [
    {
      id: "one-piece-en:discovery-seed:cards",
      surface: "@seed:cards",
      url: "https://en.onepiece-cardgame.com/cardlist/?series=569116",
    },
    {
      id: "one-piece-en:discovery-seed:products",
      surface: "@seed:products",
      url: "https://en.onepiece-cardgame.com/products/",
    },
    {
      id: "one-piece-en:discovery-seed:rules",
      surface: "@seed:rules",
      url: "https://en.onepiece-cardgame.com/rules/",
    },
  ]);

  const footer = html.lastIndexOf(navigationAnchor("FIND CARDS"));
  const singleCopy = `${html.slice(0, footer)}${
    navigationAnchor("FIND CARD")
  }${html.slice(footer + navigationAnchor("FIND CARDS").length)}`;
  assert.throws(
    () =>
      adapter.parseBytes(new TextEncoder().encode(singleCopy), {
        mediaType: fixture.metadata.content_type,
        url: request.url,
        requestId: request.id,
      }),
    /discovery/iu,
    "a single navigation copy is not the retained live discovery root",
  );
});

test("the restructured One Piece Card List leaf retains every live Card and its printed dash cost", () => {
  const adapter = requiredSourceAdapter("one-piece-en@6");
  const { fixture, observations } = retainedRestructuredParse(
    adapter,
    "one-piece-en-restructured-discovery",
    {
      url: adapter.requestUrlForSurface("card-list"),
      requestId: "one-piece-en:card-list",
    },
  );
  assert.equal(fixture.metadata.http_status, 200);
  assert.equal(observations.length, 155);
  const document =
    observations[0].source_sidecar.raw.official_surfaces[0].document;
  assert.equal(document.page, "card-list");
  assert.equal(document.declared_record_count, 155);
  assert.equal(document.recording_options.length, 59);
  assert.deepEqual(
    [...new Set(observations.flatMap(
      ({ memberships }) => memberships.source_buckets,
    ))],
    ["recording:569116"],
  );

  // The live Event Card prints an explicit "-" cost, which is retained as a
  // Card without a cost rather than as a missing field.
  const event = observations.find(
    ({ card }) => card.official_identity.value === "OP16-020",
  );
  assert.ok(event);
  assert.equal(event.card.game_data.attributes.card_type, "event");
  assert.equal(event.card.game_data.attributes.cost, null);

  const special = observations.filter(
    ({ printing }) => printing.rarity.normalized === "special",
  );
  assert.equal(special.length, 6);
  assert.deepEqual(
    [...new Set(special.map(({ printing }) => printing.rarity.raw))],
    ["SP CARD"],
  );
});

test("restructured One Piece rules discovery pins every published policy surface", () => {
  const adapter = requiredSourceAdapter("one-piece-en@6");
  const { observations } = retainedRestructuredParse(
    adapter,
    "one-piece-en-rules-hub",
    {
      url: "https://en.onepiece-cardgame.com/rules/",
      requestId: `one-piece-en:listing:rules:${restructuredStageDigest}`,
    },
  );
  assert.deepEqual(stageRecordSummaries(observations), [
    {
      id: "one-piece-en:restrictions",
      surface: "restrictions",
      url: "https://en.onepiece-cardgame.com/news/restriction.html",
    },
    {
      id: "one-piece-en:block-policy",
      surface: "block-policy",
      url: "https://en.onepiece-cardgame.com/topics/013.php",
    },
    {
      id: "one-piece-en:errata",
      surface: "errata",
      url: "https://en.onepiece-cardgame.com/rules/errata_card/",
    },
    {
      id: "one-piece-en:don-rules",
      surface: "don-rules",
      url: "https://en.onepiece-cardgame.com/rules/",
    },
  ]);
  for (const surface of ["restrictions", "block-policy", "errata"]) {
    assert.equal(
      stageRecordSummaries(observations).find(
        (record) => record.surface === surface,
      ).url,
      adapter.requestUrlForSurface(surface),
    );
  }
});

test("retained live One Piece product pages separate coded, code-less, and accessory publications", () => {
  // The live OP-17 page is a 343-byte meta-refresh stub whose only publisher
  // fact is its titled Product identity.
  const stub = retainedProductDetail(
    "one-piece-en",
    "one-piece-en-product-booster-stub",
  );
  assert.equal(stub.fixture.bytes.length, 343);
  assert.deepEqual(stub.catalogue.products, [{
    reference: { kind: "official_code", value: "OP-17" },
    official_code: "OP-17",
    name: "BOOSTER PACK -THE WORLD’S STRONGEST WARRIORS- [OP-17]",
    releases: [],
  }]);
  assert.deepEqual(Object.keys(stub.document), ["document_title"]);

  for (
    const [slug, name] of [
      [
        "one-piece-en-product-card-collection",
        "Premium Card Collection -Ace & Sabo & Luffy-",
      ],
      [
        "one-piece-en-product-anniversary-set",
        "ONE PIECE CARD GAME English Version 3rd Anniversary Set",
      ],
    ]
  ) {
    const { catalogue } = retainedProductDetail("one-piece-en", slug);
    assert.deepEqual(catalogue.products, [{
      reference: { kind: "name", value: name },
      official_code: null,
      name,
      releases: [],
    }], slug);
    assert.deepEqual(catalogue.distribution_contexts, [], slug);
  }

  retainedAccessoryContext(
    "one-piece-en",
    "one-piece-en-product-sleeve",
    "LIMITED CARD SLEEVE PREMIUM MATTE vol.6",
  );
});

test("the retained One Piece restriction publication is proven at its live redirect target", () => {
  const adapter = activeProductionAdapter("one-piece-en");
  const url = adapter.requestUrlForSurface("restrictions");
  assert.equal(url, "https://en.onepiece-cardgame.com/news/restriction.html");
  const fixture = retainedOfficialSourceFixture("one-piece-en-policy");
  // The retained bytes were captured at the pre-redirect URL; the same
  // publication now answers at the live target under one contract.
  assert.equal(
    fixture.metadata.source_url,
    "https://en.onepiece-cardgame.com/rules/restriction/",
  );
  const observations = adapter.parseBytes(fixture.bytes, {
    mediaType: fixture.metadata.content_type,
    url,
    requestId: "one-piece-en:restrictions",
  });
  const legality = observations.find(
    (observation) => observation.observation_type === "legality_rules",
  );
  assert.deepEqual(
    legality.legality_rules.map(({ card_numbers, effect }) => ({
      card_numbers,
      effect,
    })),
    [
      { card_numbers: ["OP06-047"], effect: { type: "ban" } },
      { card_numbers: ["OP03-040"], effect: { type: "ban" } },
      { card_numbers: ["OP06-086"], effect: { type: "ban" } },
      { card_numbers: ["ST10-001"], effect: { type: "ban" } },
      { card_numbers: ["OP06-116"], effect: { type: "ban" } },
      {
        card_numbers: ["OP07-115"],
        effect: {
          type: "prohibited_combination",
          with_card_numbers: ["EB04-058"],
        },
      },
      {
        card_numbers: ["OP11-040"],
        effect: {
          type: "prohibited_combination",
          with_card_numbers: ["OP11-067"],
        },
      },
      {
        card_numbers: ["OP11-040"],
        effect: {
          type: "prohibited_combination",
          with_card_numbers: ["OP08-069"],
        },
      },
    ],
  );
  assert.equal(legality.completeness.declared_record_count, 8);
  assert.equal(legality.completeness.parsed_record_count, 8);
  const surface =
    observations.find((observation) => observation.observation_type === undefined)
      .source_sidecar.raw.official_surfaces[0];
  assert.equal(surface.surface, "restrictions");
  assert.equal(surface.document.url, url);
});

test("the One Piece Block Number publication is an exactly empty policy surface", () => {
  const adapter = activeProductionAdapter("one-piece-en");
  const url = adapter.requestUrlForSurface("block-policy");
  assert.equal(url, "https://en.onepiece-cardgame.com/topics/013.php");
  const fixture = retainedOfficialSourceFixture(
    "one-piece-en-block-policy-topic",
  );
  assert.equal(fixture.metadata.source_url, url);
  const observations = adapter.parseBytes(fixture.bytes, {
    mediaType: fixture.metadata.content_type,
    url,
    requestId: "one-piece-en:block-policy",
  });
  const legality = observations.find(
    (observation) => observation.observation_type === "legality_rules",
  );
  assert.deepEqual(legality.legality_rules, []);
  assert.equal(legality.completeness.declared_record_count, 0);
  assert.equal(legality.completeness.parsed_record_count, 0);
  assert.equal(legality.completeness.structurally_complete, true);
  const surface =
    observations.find((observation) => observation.observation_type === undefined)
      .source_sidecar.raw.official_surfaces[0];
  assert.equal(surface.surface, "block-policy");
  assert.equal(
    surface.document.document_title,
    "Introduction of the Block Number System − TOPICS｜ONE PIECE CARD GAME - Official Web Site",
  );
});
