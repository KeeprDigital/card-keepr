import { test } from "vitest";
import assert from "node:assert/strict";
import { officialSourceDiscoveryRequests } from "../../src/catalogue/adapters/product-release-source-adapters.ts";
import { requiredSourceAdapter } from "../../src/catalogue/adapters/source-adapters.ts";
import syntheticOfficialSource, {
  officialPublisherPayloadScript,
  officialRawSurfacePayload,
} from "../../acceptance/fixtures/synthetic-official-source.mjs";
import {
  registeredProductionAdapters,
  retainedOfficialSourceFixture,
  restructuredStageDigest,
  retainedRestructuredParse,
  stageRecordSummaries,
  retainedProductDetail,
  retainedAccessoryContext,
} from "./official-source-raw-contract-shared.mjs";

test("One Piece parser-failure markers survive retained discovery, staged listing, and final surface transport", async () => {
  const adapter = requiredSourceAdapter("one-piece-en@6");
  const url = "https://en.onepiece-cardgame.com/cardlist/";
  // The retained discovery root now lives behind the publisher's series
  // redirect; staged listing requests must never be answered with it.
  const rootUrl = "https://en.onepiece-cardgame.com/cardlist/?series=569116";
  for (const failure of ["cap", "pagination"]) {
    const marker = `card-keepr-acceptance-parser/${failure}`;
    const responseForRole = (role) =>
      syntheticOfficialSource.fetch(
        new Request(role === null ? rootUrl : url, {
          headers: {
            "user-agent": role === null ? marker : `${marker}; request-role=${role}`,
          },
        }),
      );
    const rootBytes = new Uint8Array(await (await responseForRole(null)).arrayBuffer());
    const listingResponse = await responseForRole("listing");
    const listingBytes = new Uint8Array(await listingResponse.arrayBuffer());
    assert.notDeepEqual(listingBytes, rootBytes, "the listing request must not be routed back to retained root bytes");
    assert.deepEqual(
      adapter
        .parseBytes(listingBytes, {
          mediaType: listingResponse.headers.get("content-type"),
          url,
          requestId: `one-piece-en:listing:cards:${"a".repeat(64)}`,
        })
        .flatMap(({ records }) => records ?? [])
        .map(({ surface }) => surface),
      ["card-list"],
    );
    const surfaceResponse = await responseForRole("surface");
    const surfaceBytes = new Uint8Array(await surfaceResponse.arrayBuffer());
    assert.throws(
      () =>
        adapter.parseBytes(surfaceBytes, {
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
  const adapter = registeredProductionAdapters().find(({ sourceLineage }) => sourceLineage === "one-piece-en");
  const payload = officialRawSurfacePayload("/one-piece-en/card-list");
  payload.card_pages.forEach((card) => {
    delete card.artwork_fingerprint;
    delete card.printed_fields_digest;
  });
  const observations = adapter.parseBytes(
    new TextEncoder().encode(`<html>${officialPublisherPayloadScript("one-piece-en", "card-list", payload)}</html>`),
    {
      mediaType: "text/html; charset=utf-8",
      url: adapter.requestUrlForSurface("card-list"),
      requestId: "one-piece-en:card-list",
    },
  );
  const observation = observations.find(({ card }) => card?.official_identity?.value === "OP99-001");
  assert.ok(observation?.printing);
  assert.equal(
    observation.identity_evidence.artwork_fingerprint,
    'official-artwork:{"official_card_identity":"OP99-001","roles":["front"],"artwork_id":null}',
  );
  assert.equal(observation.identity_evidence.locator, "/cards/OP99-001");
  assert.equal(observation.identity_evidence.treatment, null);
  assert.match(observation.identity_evidence.printed_fields_digest, /printed-material:.*OP99-001/u);
});

test("mixed-content One Piece pages retain typed Errata and reject malformed corrections", () => {
  const adapter = requiredSourceAdapter("one-piece-en@6");
  const payload = officialRawSurfacePayload("/one-piece-en/errata");
  payload.declared_record_count = 1;
  payload.partition.total = 1;
  payload.entries = [
    {
      notice_id: "errata-op31-001",
      card_number: "OP31-001",
      card_name: "Complete One Piece Leader",
      published_on: "2026-08-01",
      effective_from: null,
      before_text: "Give up to 1 rested DON!! card to this Leader.",
      after_text: "Give up to 2 rested DON!! cards to this Leader.",
      note: "This correction applies in every game format.",
      applies_to_parallel_printings: true,
      image_url: "https://en.onepiece-cardgame.com/images/cardlist/card/OP31-001.png",
    },
  ];
  const observations = adapter.parseBytes(
    new TextEncoder().encode(
      `<html><p>Cards may be banned at some events unless an exception applies.</p>${officialPublisherPayloadScript("one-piece-en", "errata", payload)}</html>`,
    ),
    {
      mediaType: "text/html; charset=utf-8",
      url: adapter.requestUrlForSurface("errata"),
      requestId: "one-piece-en:errata",
    },
  );
  assert.ok(observations.every(({ observation_type }) => observation_type !== "legality_rules"));
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
    observed_printed_rules_text: "Give up to 1 rested DON!! card to this Leader.",
    corrected_rules_text: "Give up to 2 rested DON!! cards to this Leader.",
    official_wording:
      "Note: This correction applies in every game format.\n" +
      "Before: Give up to 1 rested DON!! card to this Leader.\n" +
      "After: Give up to 2 rested DON!! cards to this Leader.",
    applies_to_parallel_printings: true,
    source: {
      fragment: "#errata-op31-001",
      display_name: "OP31-001 Complete One Piece Leader",
      image_url: "https://en.onepiece-cardgame.com/images/cardlist/card/OP31-001.png",
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
    () =>
      adapter.parseBytes(
        new TextEncoder().encode(`<html>${officialPublisherPayloadScript("one-piece-en", "errata", arbitrary)}</html>`),
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
      () =>
        adapter.parseBytes(
          new TextEncoder().encode(
            `<html>${officialPublisherPayloadScript("one-piece-en", "card-list", payload)}</html>`,
          ),
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

test("the restructured One Piece discovery root repeats every publisher navigation link", () => {
  const adapter = requiredSourceAdapter("one-piece-en@6");
  const request = officialSourceDiscoveryRequests("one-piece-en")[0];
  const fixture = retainedOfficialSourceFixture("one-piece-en-restructured-discovery");
  assert.equal(fixture.metadata.source_url, request.url);
  const html = fixture.bytes.toString("utf8");
  const navigationAnchor = (label) => `<span class="menuColListLinkTit">${label}</span>`;
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
  const singleCopy = `${html.slice(0, footer)}${navigationAnchor(
    "FIND CARD",
  )}${html.slice(footer + navigationAnchor("FIND CARDS").length)}`;
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
  const { fixture, observations } = retainedRestructuredParse(adapter, "one-piece-en-restructured-discovery", {
    url: adapter.requestUrlForSurface("card-list"),
    requestId: "one-piece-en:card-list",
  });
  assert.equal(fixture.metadata.http_status, 200);
  assert.equal(observations.length, 155);
  const document = observations[0].source_sidecar.raw.official_surfaces[0].document;
  assert.equal(document.page, "card-list");
  assert.equal(document.declared_record_count, 155);
  assert.equal(document.recording_options.length, 59);
  assert.deepEqual(
    [...new Set(observations.flatMap(({ memberships }) => memberships.source_buckets))],
    ["recording:569116"],
  );

  // The live Event Card prints an explicit "-" cost, which is retained as a
  // Card without a cost rather than as a missing field.
  const event = observations.find(({ card }) => card.official_identity.value === "OP16-020");
  assert.ok(event);
  assert.equal(event.card.game_data.attributes.card_type, "event");
  assert.equal(event.card.game_data.attributes.cost, null);

  const special = observations.filter(({ printing }) => printing.rarity.normalized === "special");
  assert.equal(special.length, 6);
  assert.deepEqual([...new Set(special.map(({ printing }) => printing.rarity.raw))], ["SP CARD"]);
});

test("restructured One Piece rules discovery retains Errata discovery without requiring policy publications", () => {
  const adapter = requiredSourceAdapter("one-piece-en@6");
  const { observations } = retainedRestructuredParse(adapter, "one-piece-en-rules-hub", {
    url: "https://en.onepiece-cardgame.com/rules/",
    requestId: `one-piece-en:listing:rules:${restructuredStageDigest}`,
  });
  assert.deepEqual(stageRecordSummaries(observations), [
    {
      id: "one-piece-en:errata",
      surface: "errata",
      url: "https://en.onepiece-cardgame.com/rules/errata_card/",
    },
  ]);
  for (const surface of ["errata"]) {
    assert.equal(
      stageRecordSummaries(observations).find((record) => record.surface === surface).url,
      adapter.requestUrlForSurface(surface),
    );
  }
});

test("retained live One Piece product pages separate coded, code-less, and accessory publications", () => {
  // The live OP-17 page is a 343-byte meta-refresh stub whose only publisher
  // fact is its titled Product identity.
  const stub = retainedProductDetail("one-piece-en", "one-piece-en-product-booster-stub");
  assert.equal(stub.fixture.bytes.length, 343);
  assert.deepEqual(stub.catalogue.products, [
    {
      reference: { kind: "official_code", value: "OP-17" },
      official_code: "OP-17",
      name: "BOOSTER PACK -THE WORLD’S STRONGEST WARRIORS- [OP-17]",
      releases: [],
    },
  ]);
  assert.deepEqual(Object.keys(stub.document), ["document_title"]);

  for (const [slug, name] of [
    ["one-piece-en-product-card-collection", "Premium Card Collection -Ace & Sabo & Luffy-"],
    ["one-piece-en-product-anniversary-set", "ONE PIECE CARD GAME English Version 3rd Anniversary Set"],
  ]) {
    const { catalogue } = retainedProductDetail("one-piece-en", slug);
    assert.deepEqual(
      catalogue.products,
      [
        {
          reference: { kind: "name", value: name },
          official_code: null,
          name,
          releases: [],
        },
      ],
      slug,
    );
    assert.deepEqual(catalogue.distribution_contexts, [], slug);
  }

  retainedAccessoryContext("one-piece-en", "one-piece-en-product-sleeve", "LIMITED CARD SLEEVE PREMIUM MATTE vol.6");
});
