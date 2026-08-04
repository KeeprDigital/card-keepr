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
      (surface !== "card-search" && surface !== "errata") ||
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
    const script = html.match(
      /<script type="application\/json" id="fusion-world-card-game-card-search-data">([\s\S]*?)<\/script>/u,
    );
    if (script === null) return response;

    const payload = JSON.parse(script[1]);
    const detail = payload.detail_pages[0];
    const locator = `${detail.card_number}_p2`;
    detail.detail_path = locator;
    detail.variant = "_p2";
    payload.result.partitions[0].entries[0].detail = locator;

    const repeated = structuredClone(payload.result.partitions[0].entries[0]);
    payload.result.partitions[1].entries = [repeated];
    payload.result.partitions[1].total = 1;

    const replacement = officialPublisherPayloadScript(
      "fusion-world-en",
      "card-search",
      payload,
    );
    return htmlResponse(response, html.replace(script[0], replacement));
  },
};

function htmlResponse(response, body) {
  return new Response(body, {
      status: response.status,
      headers: response.headers,
  });
}
