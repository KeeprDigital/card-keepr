// Shared tables and helpers for the per-lineage Official Source raw-contract
// files in this directory.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { requiredSourceAdapter, sourceAdapterRegistrations } from "../../src/catalogue/adapters/source-adapters.ts";
import {
  officialPublisherPayloadScript,
  officialRawSurfacePayload,
} from "../../acceptance/fixtures/synthetic-official-source.mjs";

// This matrix owns the retained Bandai fixture families; other installed sources have their own retained-byte tests.
export const productionAdapterVersions = sourceAdapterRegistrations
  .filter(
    ({ origin, reconciliationCapability, parseBytes, sourceLineage }) =>
      origin === "production" &&
      reconciliationCapability === "catalogue" &&
      typeof parseBytes === "function" &&
      ["one-piece-en", "fusion-world-en", "digimon-en", "gundam-en-asia", "gundam-en-us"].includes(sourceLineage),
  )
  .map(({ adapterVersion }) => adapterVersion);

export function registeredProductionAdapters() {
  return productionAdapterVersions.map((adapterVersion) => requiredSourceAdapter(adapterVersion));
}

export function retainedOfficialSourceFixture(slug) {
  const metadata = JSON.parse(
    readFileSync(new URL(`../../acceptance/fixtures/retained-official-source/${slug}.json`, import.meta.url), "utf8"),
  );
  const bytes = Buffer.from(metadata.body_base64, "base64");
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    metadata.body_sha256,
    `${slug} retained bytes changed`,
  );
  assert.equal(
    bytes.length,
    metadata.range_end_exclusive - metadata.range_start,
    `${slug} retained byte range changed`,
  );
  assert.match(metadata.full_body_sha256, /^[0-9a-f]{64}$/u);
  // 08-02 to 08-07 captured the restructured generation; 08-11 captured the
  // optional-card-field pages (Fusion Energy Markers, Digimon nested Q&A);
  // 08-12 captured the fusion live-shape pages (anchored product status
  // sections, errata-annotated details, the season Release, and the
  // legality-history restriction lift).
  assert.match(metadata.retrieved_at, /^2026-08-(?:0[2-7]|1[12])T/u);
  return { bytes, metadata };
}

export const restructuredStageDigest = "0".repeat(64);

export function retainedRestructuredParse(adapter, slug, context) {
  const fixture = retainedOfficialSourceFixture(slug);
  return {
    fixture,
    observations: adapter.parseBytes(fixture.bytes, {
      mediaType: fixture.metadata.content_type,
      ...context,
    }),
  };
}

export function retainedRestructuredRequests(adapter, slug, context) {
  const fixture = retainedOfficialSourceFixture(slug);
  return adapter.discoverRequests(fixture.bytes, {
    mediaType: fixture.metadata.content_type,
    ...context,
  });
}

export function stageRecordSummaries(observations) {
  return observations.flatMap(({ records }) => records ?? []).map(({ id, surface, url }) => ({ id, surface, url }));
}

export function exactMessage(message) {
  return (error) => {
    assert.equal(error.message, message);
    return true;
  };
}

// The five exact live shapes retained by the 2026-08-12 full-scale Fusion
// World run. Every fixture below carries the exact live bytes that the
// pre-live-shape generation failed on in production; the live adapters
// parse them.
export const fusionLiveShapeAdapter = () => requiredSourceAdapter("fusion-world-en@9");

export const fusionProductListingFixtures = [
  {
    slug: "fusion-world-en-products-hub",
    url: "https://www.dbs-cardgame.com/fw/en/products/",
    requestId: "fusion-world-en:products",
  },
  {
    slug: "fusion-world-en-products-page2",
    url: "https://www.dbs-cardgame.com/fw/en/products/?page=2",
    requestId: `fusion-world-en:listing:${restructuredStageDigest}`,
  },
  {
    slug: "fusion-world-en-products-starter-tag",
    url: "https://www.dbs-cardgame.com/fw/en/products/?tags=StarterDecks&page=1",
    requestId: `fusion-world-en:listing:${restructuredStageDigest}`,
  },
];

export const fusionErrataDetailFixtures = [
  {
    slug: "fusion-world-en-card-detail-errata-skills",
    url: "https://www.dbs-cardgame.com/fw/en/cardlist/detail.php?card_no=SB01-039",
  },
  {
    slug: "fusion-world-en-card-detail-errata-leader",
    url: "https://www.dbs-cardgame.com/fw/en/cardlist/detail.php?card_no=FS10-01",
  },
  {
    slug: "fusion-world-en-card-detail-errata-leader-p1",
    url: "https://www.dbs-cardgame.com/fw/en/cardlist/detail.php?card_no=FS10-01&p=_p1",
  },
  {
    slug: "fusion-world-en-card-detail-errata-traits",
    url: "https://www.dbs-cardgame.com/fw/en/cardlist/detail.php?card_no=FP-088",
  },
];

export const fusionLegalityHistoryUrl = "https://www.dbs-cardgame.com/fw/en/news/01_399.html";

// The live product-detail generation: every retained page below is a complete
// publisher body captured from the site that broke production run run_085d6d,
// where the leading <h1> became the site logo on every product page.
// The issue-58 generation keeps the live product-detail contracts unchanged
// for One Piece and Gundam while closing their legality walls.
export const liveProductAdapterVersions = {
  "one-piece-en": "one-piece-en@6",
  "fusion-world-en": "fusion-world-en@9",
  "digimon-en": "digimon-en@7",
  "gundam-en-asia": "gundam-en-asia@7",
  "gundam-en-us": "gundam-en-us@7",
};

export function activeProductionAdapter(sourceLineage) {
  const adapter = requiredSourceAdapter(liveProductAdapterVersions[sourceLineage]);
  assert.ok(
    registeredProductionAdapters().includes(adapter),
    `${sourceLineage} must resolve its live-product version as the active adapter`,
  );
  return adapter;
}

export function retainedProductDetail(sourceLineage, slug, adapter) {
  const resolved = adapter ?? activeProductionAdapter(sourceLineage);
  const fixture = retainedOfficialSourceFixture(slug);
  const observations = resolved.parseBytes(fixture.bytes, {
    mediaType: "text/html",
    url: fixture.metadata.source_url,
    requestId: `${sourceLineage}:product_detail:${restructuredStageDigest}`,
  });
  assert.equal(observations.length, 1, slug);
  return {
    fixture,
    catalogue: observations[0].product_release_catalogue,
    document: observations[0].source_sidecar.raw.official_surfaces[0].document,
  };
}

export function retainedAccessoryContext(sourceLineage, slug, title) {
  const { catalogue, document } = retainedProductDetail(sourceLineage, slug);
  assert.deepEqual(catalogue.products, [], slug);
  assert.deepEqual(catalogue.relationships, [], slug);
  assert.deepEqual(
    catalogue.distribution_contexts,
    [
      {
        key: `non-card:accessory:${title.toLocaleLowerCase()}`,
        kind: "other",
        label: "accessory",
        evidence_category: "explicit",
      },
    ],
    slug,
  );
  assert.equal(document.document_title, title, slug);
}

export function rawSurfacePayload(lineage, surface) {
  const payload = structuredClone(officialRawSurfacePayload(`/${lineage}/${surface}`));
  if (lineage === "one-piece-en" && surface === "don-rules") {
    payload.don_card = {
      functional_designation: "DON!!",
      name: "DON!! Card",
      Category: "DON!! Card",
      Effect: "A rules-level resource Card used to pay costs and increase power.",
    };
  }
  return payload;
}

export function parseRegisteredSurface(adapter, surface, payload) {
  const completeDigimonLeaf = adapter.sourceLineage === "digimon-en" && surface === "card-list";
  const completeGundamLeaf = adapter.sourceLineage.startsWith("gundam-") && surface === "packages";
  const publisherPayload = structuredClone(payload);
  if (adapter.sourceLineage === "one-piece-en" && surface === "card-list") {
    publisherPayload.card_pages.forEach((card) => {
      delete card.artwork_fingerprint;
      delete card.printed_fields_digest;
    });
  }
  if (completeDigimonLeaf) {
    for (const detail of publisherPayload.card_popups ?? []) {
      delete detail.artwork_fingerprint;
      delete detail.printed_fields_digest;
      delete detail.printing.normalized_rarity;
    }
  }
  if (completeGundamLeaf) {
    for (const detail of publisherPayload.card_details ?? []) {
      delete detail.artwork_fingerprint;
      delete detail.printed_fields_digest;
      delete detail.printing.normalized_rarity;
    }
  }
  return adapter.parseBytes(
    new TextEncoder().encode(
      `<html><title>BANDAI ${adapter.supportedGame} CARD PRODUCT RELEASE RULE ERRATA RESTRICTION</title>
       ${officialPublisherPayloadScript(adapter.sourceLineage, surface, publisherPayload)}`,
    ),
    {
      mediaType: "text/html; charset=utf-8",
      url: completeDigimonLeaf
        ? `${adapter.requestUrlForSurface(surface)}&category=all&cardcategory=digimon&colour=blue`
        : completeGundamLeaf
          ? `${adapter.requestUrlForSurface(surface)}?package=all`
          : adapter.requestUrlForSurface(surface),
      requestId:
        completeDigimonLeaf || completeGundamLeaf
          ? `${adapter.sourceLineage}:listing:${"f".repeat(64)}`
          : `${adapter.sourceLineage}:${surface}`,
    },
  );
}
