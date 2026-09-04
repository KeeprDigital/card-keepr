import type { FailureInjection } from "./failure-injection.ts";
import type { OfficialLineage } from "./hostnames.ts";
import type { ProductionSourceFixtureRole } from "./production-source-fixture-routing.ts";

// One request as the fake publisher sees it: the routed lineage plus the
// marker, role, and surface the ingestion runtime encodes into the
// user-agent header of every derived request.
export interface PublisherRequest {
  readonly request: Request;
  readonly url: URL;
  readonly lineage: OfficialLineage | null;
  readonly marker: string | null;
  readonly role: ProductionSourceFixtureRole;
  readonly surface: string | null;
  readonly failures: FailureInjection;
}

// A scenario answers the requests it recognises and yields (null) to the next
// scenario for everything else.
export type PublisherScenario = (
  context: PublisherRequest,
) => Response | null | Promise<Response | null>;
