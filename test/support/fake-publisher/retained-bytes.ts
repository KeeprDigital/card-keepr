import digimonDiscovery from "../../../acceptance/fixtures/retained-official-source/digimon-en-discovery.json" with {
  type: "json",
};
import fusionWorldDiscovery from "../../../acceptance/fixtures/retained-official-source/fusion-world-en-restructured-card-search.json" with {
  type: "json",
};
import gundamAsiaDiscovery from "../../../acceptance/fixtures/retained-official-source/gundam-en-asia-discovery.json" with {
  type: "json",
};
import gundamUsDiscovery from "../../../acceptance/fixtures/retained-official-source/gundam-en-us-discovery.json" with {
  type: "json",
};
import onePieceDiscovery from "../../../acceptance/fixtures/retained-official-source/one-piece-en-restructured-discovery.json" with {
  type: "json",
};
import type { OfficialLineage } from "./hostnames.ts";
import { productionSourceFixtureRole } from "./production-source-fixture-routing.ts";

export interface RetainedOfficialSourceFixture {
  readonly source_url: string;
  readonly content_type: string;
  readonly body_base64: string;
}

// The one routing table from a lineage to the retained discovery-root bytes
// its production adapter parses. Every layer serves the same capture from
// here, so a re-captured fixture changes every suite at once.
export const retainedOfficialDiscoveryFixtures: Record<
  OfficialLineage,
  RetainedOfficialSourceFixture
> = {
  "one-piece-en": onePieceDiscovery,
  "fusion-world-en": fusionWorldDiscovery,
  "digimon-en": digimonDiscovery,
  "gundam-en-asia": gundamAsiaDiscovery,
  "gundam-en-us": gundamUsDiscovery,
};

// Decodes without Buffer so the same table serves from workerd and Node.
export function retainedOfficialDiscoveryBytes(
  lineage: OfficialLineage,
): Uint8Array {
  return Uint8Array.from(
    atob(retainedOfficialDiscoveryFixtures[lineage].body_base64),
    (character) => character.charCodeAt(0),
  );
}

// The retained Fusion World card search links the rules hub as its last
// navigation entry; the incomplete-discovery scenario rewrites that link to a
// missing page so discovery observes a publisher gap.
const incompleteDiscoveryMarker = "card-keepr-incomplete-discovery-v3";

export function retainedOfficialDiscoveryResponse(
  lineage: OfficialLineage,
  request: Request,
  options: { readonly marker?: string | null; readonly etag: string },
): Response | null {
  const fixture = retainedOfficialDiscoveryFixtures[lineage];
  if (
    request.url !== fixture.source_url ||
    productionSourceFixtureRole(request.headers) !== "retained-discovery"
  ) return null;
  const retainedBytes = retainedOfficialDiscoveryBytes(lineage);
  const responseBytes =
    options.marker === incompleteDiscoveryMarker &&
      lineage === "fusion-world-en"
      ? new TextEncoder().encode(
        new TextDecoder().decode(retainedBytes).replace(
          "/fw/en/news/01_31.html",
          "/fw/en/news/missing.html",
        ),
      )
      : retainedBytes;
  return new Response(responseBytes, {
    headers: {
      "content-type": fixture.content_type,
      etag: options.etag,
    },
  });
}
