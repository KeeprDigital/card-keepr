// The synthetic Official Source the acceptance harness boots with wrangler and
// binds to the ingestion Worker as OFFICIAL_SOURCE_TRANSPORT. It serves the
// shared fake publisher's acceptance scenario catalogue; the publication
// fixtures the raw-contract tests read are re-exported from the same module.
import {
  acceptanceScenarios,
  createFakePublisher,
} from "../../test/support/fake-publisher/index.ts";

export {
  officialBandaiNavigationHeader,
  officialDiscoveryDefinitions,
  officialDiscoveryDocument,
  officialPublisherPayloadScript,
  officialRawSurfacePayload,
} from "../../test/support/fake-publisher/index.ts";

const publisher = createFakePublisher({ scenarios: acceptanceScenarios });

export default {
  fetch(request) {
    return publisher.fetch(request);
  },
};
