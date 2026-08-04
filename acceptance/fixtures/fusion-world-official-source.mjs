import syntheticOfficialSource, {
  officialPublisherPayloadScript,
} from "./synthetic-official-source.mjs";
import {
  productionSourceFixtureMarker,
  productionSourceFixtureSurface,
} from "../../apps/ingestion/test/production-source-fixture-routing.ts";

const fixtureMarker = "card-keepr-acceptance-fusion-world-issue-32";

export default {
  async fetch(request) {
    const response = await syntheticOfficialSource.fetch(request);
    const marker = productionSourceFixtureMarker(request.headers);
    const surface = productionSourceFixtureSurface(request.headers);
    if (
      !marker?.startsWith(fixtureMarker) ||
      ![
        "card-search",
        "products",
        "releases",
        "legality-current",
        "legality-history",
        "errata",
      ].includes(surface) ||
      (surface === "errata" && marker !== `${fixtureMarker}-errata`) ||
      !response.headers.get("content-type")?.startsWith("text/html")
    ) {
      return response;
    }

    const html = await response.text();
    if (surface === "errata" && marker === `${fixtureMarker}-errata`) {
      const script = html.match(
        /<script type="application\/json" id="fusion-world-card-game-errata-data">([\s\S]*?)<\/script>/u,
      );
      if (script === null) return response;
      const payload = JSON.parse(script[1]);
      payload.declared_record_count = 1;
      payload.partition.total = 1;
      payload.entries = [{
        entry_id: "fusion-world-erratum-fb99-001",
        card_number: "FB99-001",
        published_on: "2026-07-15",
        effective_from: "2026-07-15",
        before: "Official printed rules",
        after: "Official corrected rules",
        notice: "The corrected wording applies from the published date.",
        image_url:
          "https://www.dbs-cardgame.com/fw/images/FB99-001-errata.png",
      }];
      return htmlResponse(
        response,
        html.replace(
          script[0],
          officialPublisherPayloadScript(
            "fusion-world-en",
            "errata",
            payload,
          ),
        ),
      );
    }
    const script = html.match(new RegExp(
      `<script type="application/json" id="fusion-world-card-game-${surface}-data">([\\s\\S]*?)</script>`,
      "u",
    ));
    if (script === null) return response;

    const payload = JSON.parse(script[1]);
    if (surface === "card-search") {
      completeCardSearchPayload(payload, marker);
    } else if (surface === "products") {
      payload.result.partitions
        .find(({ bucket }) => bucket === "coming-soon")
        .entries.push(comingSoonProduct());
      payload.result.partitions
        .find(({ bucket }) => bucket === "coming-soon").total = 1;
    } else if (surface === "releases") {
      payload.events.partitions[0].entries.push({
        product: comingSoonProduct(),
        release: {
          productCode: "FB-COMING-02",
          releaseId: "fusion-world-coming-02-announcement",
          region: "EN-US",
          precision: "unknown",
          date: null,
          status: "announced",
        },
      });
      payload.events.partitions[0].total += 1;
    } else if (
      surface === "legality-current" || surface === "legality-history"
    ) {
      payload.declared_record_count = 1;
      payload.partition.total = 1;
      payload.entries = [fusionWorldLegalityRule(surface)];
    }

    const replacement = officialPublisherPayloadScript(
      "fusion-world-en",
      surface,
      payload,
    );
    return htmlResponse(response, html.replace(script[0], replacement));
  },
};

function completeCardSearchPayload(payload, marker) {
  const detail = payload.detail_pages[0];
  const locator = `${detail.card_number}_p2`;
  detail.detail_path = locator;
  detail.variant = "_p2";
  payload.result.partitions[0].entries[0].detail = locator;

  const repeated = structuredClone(payload.result.partitions[0].entries[0]);
  payload.result.partitions[1].entries = [repeated];
  payload.result.partitions[1].total = 1;

  if (marker === `${fixtureMarker}-capped-leaf`) {
    payload.result.partitions[0].result_cap = "Too many search results";
  } else if (marker === `${fixtureMarker}-mismatched-detail`) {
    detail.card_number = "FB99-999";
  } else if (marker === `${fixtureMarker}-missing-leader-face`) {
    detail.image_urls = detail.image_urls.filter(({ role }) => role !== "back");
  } else if (marker === `${fixtureMarker}-conflicting-locator`) {
    const conflicting = structuredClone(
      payload.result.partitions[0].entries[0],
    );
    conflicting.number = "FB99-999";
    payload.result.partitions[0].entries.push(conflicting);
    payload.result.partitions[0].total = 2;
  }
}

function comingSoonProduct() {
  return {
    productCode: "FB-COMING-02",
    productName: "Fusion World Coming Soon Product",
    distribution: {
      code: "FB-COMING-02-distribution",
      kind: "product",
      label: "Fusion World Coming Soon Product distribution",
      product_reference: {
        kind: "official_code",
        value: "FB-COMING-02",
      },
    },
  };
}

function fusionWorldLegalityRule(surface) {
  const historical = surface === "legality-history";
  return {
    rule_ref: historical
      ? "fusion-world-history-fb99-001"
      : "fusion-world-current-fb99-001",
    notice:
      "FB99-001 is eligible for Standard events in the EN-OCEANIA region.",
    market: "EN-OCEANIA",
    play_format: "standard",
    tier: null,
    active_on: historical ? "2025-01-01" : "2026-01-01",
    expires_on: historical ? "2025-12-31" : null,
    cards: ["FB99-001"],
    directive: "eligible",
  };
}

function htmlResponse(response, body) {
  return new Response(body, {
      status: response.status,
      headers: response.headers,
  });
}
