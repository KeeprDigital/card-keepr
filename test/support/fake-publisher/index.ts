// The fake publisher every test layer imports: the ingestion workers-pool
// suites mount it as the Miniflare outbound service, the synthetic Official
// Source wrangler worker behind the acceptance harness serves it, and the
// runtime-free contract tests call it directly. It owns hostname routing,
// retained-bytes serving, failure injection, and the Cloudflare API mock;
// consumers pick the scenario catalogue their layer publishes.
import { createFailureInjection } from "./failure-injection.ts";
import { officialLineageForUrl } from "./hostnames.ts";
import {
  productionSourceFixtureMarker,
  productionSourceFixtureRole,
  productionSourceFixtureSurface,
} from "./production-source-fixture-routing.ts";
import type { PublisherRequest, PublisherScenario } from "./scenario.ts";

export type { OfficialLineage } from "./hostnames.ts";
export type { PublisherRequest, PublisherScenario } from "./scenario.ts";
export {
  cloudflareApiMock,
  type CloudflareApiMockOptions,
} from "./cloudflare-api.ts";
export {
  createFailureInjection,
  failureInjectionScope,
  transportOutcomeForPath,
  transportOutcomeForUserAgent,
  type FailureInjection,
} from "./failure-injection.ts";
export {
  isSyntheticOfficialSourceHost,
  officialLineageForUrl,
  officialLineageHostnames,
  syntheticOfficialSourceHostSuffix,
} from "./hostnames.ts";
export {
  retainedOfficialDiscoveryBytes,
  retainedOfficialDiscoveryFixtures,
  retainedOfficialDiscoveryResponse,
} from "./retained-bytes.ts";
export {
  productionOfficialStageResponse,
  productionSourceFixtureIsProductDetail,
  productionSourceFixtureMarker,
  productionSourceFixtureRole,
  productionSourceFixtureSurface,
} from "./production-source-fixture-routing.ts";
export {
  officialBandaiNavigationHeader,
  officialDiscoveryDefinitions,
  officialDiscoveryDocument,
  officialPublisherPayloadScript,
  officialRawSurfacePayload,
} from "./official-source-fixtures.mjs";
export { acceptanceScenarios } from "./acceptance-scenarios.mjs";
export {
  workersPoolOfficialSourceScenario,
  workersPoolScenarios,
  workersPoolSyntheticHostScenario,
} from "./workers-pool-scenarios.ts";

export interface FakePublisher {
  fetch(request: Request): Promise<Response>;
}

export interface FakePublisherOptions {
  readonly scenarios: readonly PublisherScenario[];
}

export function createFakePublisher(options: FakePublisherOptions): FakePublisher {
  const failures = createFailureInjection();
  return {
    async fetch(request) {
      const url = new URL(request.url);
      const context: PublisherRequest = {
        request,
        url,
        lineage: officialLineageForUrl(url),
        marker: productionSourceFixtureMarker(request.headers),
        role: productionSourceFixtureRole(request.headers),
        surface: productionSourceFixtureSurface(request.headers),
        failures,
      };
      for (const scenario of options.scenarios) {
        const response = await scenario(context);
        if (response !== null) return response;
      }
      return new Response("not found", { status: 404 });
    },
  };
}
