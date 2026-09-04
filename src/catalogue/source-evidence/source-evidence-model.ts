import { canonicalJson, sha256, utf8, AdministrationProblem } from "../shared";
import {
  assertAdapterRequestSurface,
  assertAdapterBinding,
  assertOfficialSourceUrl,
  requiredActiveSourceAdapter,
  requiredOfficialSourceContract,
  requiredSourceAdapter,
  type SourceAdapterRegistration,
} from "../adapters";

// The polite steady-state interval between requests to one Official Source
// hostname when no deployment override is configured.
export const defaultSourceHostPacingIntervalMilliseconds = 500;

export type SourceRequestRole = "surface" | "listing" | "detail" | "product_detail" | "image";

// Per-role transport policy. A missing listing, detail, product, or surface
// response means missing catalogue facts, so exhausting those bounded
// transport retries pauses the run (Retry Pause) until the Official Source
// recovers, and every terminal outcome (a non-retryable status, a redirect,
// a rejected revalidation, a body-contract violation) fails the run. A
// Printing Image is a static file that reconciliation can publish without:
// exhausting its retries or reaching a terminal outcome records that one
// request as failed under a distinct, class-specific code and collection
// continues, so a slow CDN path or a removed file cannot stall or discard a
// run once per stubborn image. Image fetches also get a longer bound, so
// slow-but-succeeding transfers complete instead of retrying.
export type SourceRequestTransportPolicy = Readonly<{
  timeout_ms: number;
  on_transport_exhaustion: "pause_run" | "fail_request";
  on_terminal_outcome: "fail_run" | "fail_request";
}>;

const catalogueFactTransportPolicy: SourceRequestTransportPolicy = {
  timeout_ms: 30_000,
  on_transport_exhaustion: "pause_run",
  on_terminal_outcome: "fail_run",
};

const printingImageTransportPolicy: SourceRequestTransportPolicy = {
  timeout_ms: 60_000,
  on_transport_exhaustion: "fail_request",
  on_terminal_outcome: "fail_request",
};

export function transportPolicyForRole(role: SourceRequestRole): SourceRequestTransportPolicy {
  return role === "image" ? printingImageTransportPolicy : catalogueFactTransportPolicy;
}

// The classes of Source Request failure capture records on a request. Every
// class maps to one stable failure code per transport policy: the
// catalogue-fact codes fail the run, the image codes fail the request alone.
export type SourceRequestFailureClass =
  | "retries_exhausted"
  | "not_found"
  | "rejected"
  | "redirected"
  | "revalidation_rejected"
  | "body_contract";

const catalogueFactFailureCodes: Readonly<Record<SourceRequestFailureClass, string>> = {
  retries_exhausted: "source_request_retries_exhausted",
  not_found: "source_request_rejected",
  rejected: "source_request_rejected",
  redirected: "source_redirect_rejected",
  revalidation_rejected: "source_revalidation_rejected",
  body_contract: "source_request_retries_exhausted",
};

const printingImageFailureCodes: Readonly<Record<SourceRequestFailureClass, string>> = {
  retries_exhausted: "source_image_retries_exhausted",
  not_found: "source_image_not_found",
  rejected: "source_image_rejected",
  redirected: "source_image_redirected",
  revalidation_rejected: "source_image_revalidation_rejected",
  body_contract: "source_image_body_contract",
};

// The stable failure code of an image Source Request whose bounded
// transport retries were exhausted under the fail-request policy.
export const printingImageRetriesExhaustedFailureCode = printingImageFailureCodes.retries_exhausted;

// Every failure code a Printing Image request can carry without failing or
// pausing its run, in a stable order for SQL `json_each` membership tests.
export const toleratedPrintingImageFailureCodes: readonly string[] = Object.freeze(
  Object.values(printingImageFailureCodes),
);

// The failure code one request records for a failure class under its role's
// transport policy.
export function requestFailureCode(role: SourceRequestRole, failureClass: SourceRequestFailureClass): string {
  return transportPolicyForRole(role).on_terminal_outcome === "fail_request"
    ? printingImageFailureCodes[failureClass]
    : catalogueFactFailureCodes[failureClass];
}

// The failure class of a non-success HTTP status that is never retried: a
// missing file is distinguished from every other refusal so the gap stays
// diagnosable. Retryable statuses (429 and 5xx) have no terminal class.
export function terminalHttpFailureClass(
  status: number,
): Extract<SourceRequestFailureClass, "not_found" | "rejected"> | null {
  if (status === 404 || status === 410) return "not_found";
  return status !== 429 && status < 500 ? "rejected" : null;
}

// A failed Source Request that collection completion, reconciliation, and
// publication tolerate: the run proceeds and the missing Printing Image is
// recorded explicitly instead of failing the run.
export function toleratesRequestFailure(role: SourceRequestRole, failureCode: string | null): boolean {
  return role === "image" && failureCode !== null && toleratedPrintingImageFailureCodes.includes(failureCode);
}

const allowedRequestHeaders = new Set(["accept", "accept-language", "user-agent"]);
const maximumOfficialSourceUrlBytes = 2_048;
const maximumOfficialSourceHeadersBytes = 2_048;

export type EvidencePlanRequest = {
  id: string;
  url: string;
  method: "GET";
  headers: Record<string, string>;
  representation_fingerprint: string;
};

export type OfficialSourceCollectionRequest = EvidencePlanRequest & {
  surface: string;
};

export type OfficialSourceCollectionPlan = {
  contract: "card-keepr-official-source-collection-plan@1";
  supported_game: string;
  source_lineage: string;
  game_profile_version: string;
  adapter_version: string;
  discovery_observation_set_id: string;
  requests: OfficialSourceCollectionRequest[];
};

export type EvidencePlan = {
  supported_game: string;
  source_lineage: string;
  game_profile_version: string;
  adapter_version: string;
  requests: EvidencePlanRequest[];
};

export type EvidencePlanInput = {
  supported_game: string;
  source_lineage: string;
  adapter_version: string;
  requests: readonly {
    id: string;
    url: string;
    method?: string;
    headers?: Record<string, string>;
  }[];
};

export type StartEvidenceRunRequest =
  | (EvidencePlanInput & {
      idempotency_key: string;
      operational_request_id?: string;
    })
  | {
      plans: readonly EvidencePlanInput[];
      idempotency_key: string;
      operational_request_id?: string;
    };

export type EvidenceParentWorkflowParams = {
  ingestion_run_id: string;
};

export type EvidenceHostWorkflowParams = {
  ingestion_run_id: string;
  hostname: string;
  minimum_sequence_number: number;
  maximum_sequence_number: number;
};

export async function validateEvidencePlan(
  request: EvidencePlanInput & { idempotency_key: string },
  planOrigin: SourceAdapterRegistration["origin"] = "production",
): Promise<{
  plan: EvidencePlan;
  adapter: SourceAdapterRegistration;
}> {
  assertIdentifier(request.supported_game, "supported_game");
  assertIdentifier(request.source_lineage, "source_lineage");
  assertIdentifier(request.adapter_version, "adapter_version");
  assertIdentifier(request.idempotency_key, "idempotency_key");
  const adapter =
    planOrigin === "production"
      ? requiredActiveSourceAdapter(request.adapter_version)
      : requiredSourceAdapter(request.adapter_version);
  if (adapter.origin !== planOrigin) {
    throw new AdministrationProblem(
      422,
      "adapter_origin_not_permitted",
      planOrigin === "production"
        ? "Synthetic fixture adapters are unavailable on the production source-plan route."
        : "The internal fixture source-plan route accepts only synthetic fixture adapters.",
    );
  }
  assertAdapterBinding(adapter, {
    sourceLineage: request.source_lineage,
    supportedGame: request.supported_game,
  });
  if (request.requests.length === 0 || request.requests.length > 100) {
    throw new AdministrationProblem(
      422,
      "invalid_parameter",
      "requests must contain between 1 and 100 Official Source requests.",
    );
  }
  const requestIds = new Set<string>();
  const requests: EvidencePlanRequest[] = [];
  for (const sourceRequest of request.requests) {
    assertIdentifier(sourceRequest.id, "requests[].id");
    if (requestIds.has(sourceRequest.id)) {
      throw new AdministrationProblem(
        422,
        "invalid_parameter",
        "Each Official Source request identity must be unique.",
      );
    }
    requestIds.add(sourceRequest.id);
    if (sourceRequest.method !== undefined && sourceRequest.method !== "GET") {
      throw new AdministrationProblem(
        422,
        "invalid_parameter",
        "Official Source evidence capture currently permits only GET.",
      );
    }
    const url = validOfficialSourceUrl(sourceRequest.url);
    assertAdapterRequestSurface(adapter, url);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(sourceRequest.headers ?? {})) {
      const normalizedName = name.toLowerCase();
      if (!allowedRequestHeaders.has(normalizedName)) {
        throw new AdministrationProblem(
          422,
          "unsafe_source_request_header",
          `Official Source request header ${name} is not permitted.`,
        );
      }
      if (normalizedName === "user-agent") {
        const canonical = canonicalOfficialSourceUserAgent(value);
        if (canonical.length > 0) headers[normalizedName] = canonical;
      } else {
        headers[normalizedName] = value;
      }
    }
    assertBoundedOfficialSourceRequest(url.href, headers, false);
    requests.push({
      id: sourceRequest.id,
      url: url.href,
      method: "GET",
      headers,
      representation_fingerprint: await representationFingerprint({
        method: "GET",
        url: url.href,
        headers,
      }),
    });
  }
  if (adapter.requestUrlForDiscovery !== undefined) {
    const expectedIds = [`${adapter.sourceLineage}:discovery`];
    const actualIds = requests.map(({ id }) => id);
    if (actualIds.length !== expectedIds.length || expectedIds.some((id) => !requestIds.has(id))) {
      throw new AdministrationProblem(
        422,
        "incomplete_source_plan",
        "A complete Official Source Evidence Plan must contain its one exact discovery request.",
      );
    }
    for (const sourceRequest of requests) {
      if (new URL(sourceRequest.url).href !== new URL(adapter.requestUrlForDiscovery()).href) {
        throw new AdministrationProblem(
          422,
          "source_surface_binding_mismatch",
          "The discovery request must use its exact Official Source URL contract.",
        );
      }
    }
  } else if (adapter.requiredSurfaces !== undefined) {
    const expectedIds = adapter.requiredSurfaces.map((surface) => `${adapter.sourceLineage}:${surface}`);
    const actualIds = requests.map(({ id }) => id);
    if (actualIds.length !== expectedIds.length || expectedIds.some((id) => !requestIds.has(id))) {
      throw new AdministrationProblem(
        422,
        "incomplete_source_plan",
        "The Evidence Plan must contain every exact required Official Source surface once.",
      );
    }
    if (adapter.requestUrlForSurface === undefined) {
      throw new Error("A production adapter with required surfaces has no request-URL contract.");
    }
    for (const sourceRequest of requests) {
      const surface = sourceRequest.id.slice(`${adapter.sourceLineage}:`.length);
      if (new URL(sourceRequest.url).href !== new URL(adapter.requestUrlForSurface(surface)).href) {
        throw new AdministrationProblem(
          422,
          "source_surface_binding_mismatch",
          "Every Source Request identity must use its exact Official Source surface URL contract.",
        );
      }
    }
  }
  return {
    adapter,
    plan: {
      supported_game: adapter.supportedGame,
      source_lineage: adapter.sourceLineage,
      game_profile_version: adapter.gameProfileVersion,
      adapter_version: adapter.adapterVersion,
      requests,
    },
  };
}

export function assertBoundedOfficialSourceRequest(
  url: string,
  headers: Readonly<Record<string, string>>,
  discovered: boolean,
): void {
  if (
    utf8(url).byteLength > maximumOfficialSourceUrlBytes ||
    utf8(canonicalJson(headers)).byteLength > maximumOfficialSourceHeadersBytes
  ) {
    throw new AdministrationProblem(
      422,
      discovered ? "source_discovery_failed" : "invalid_parameter",
      "Official Source request URL and headers must fit the bounded Workflow identity contract.",
    );
  }
}

export async function validateEvidencePlans(
  request: StartEvidenceRunRequest,
  planOrigin: SourceAdapterRegistration["origin"] = "production",
): Promise<EvidencePlan[]> {
  assertIdentifier(request.idempotency_key, "idempotency_key");
  const inputs = "plans" in request ? request.plans : [request];
  if (inputs.length < 1 || inputs.length > 20) {
    throw new AdministrationProblem(422, "invalid_parameter", "plans must contain between 1 and 20 Evidence Plans.");
  }
  const plans: EvidencePlan[] = [];
  const requestIds = new Set<string>();
  const reconciliationCapabilities = new Set<SourceAdapterRegistration["reconciliationCapability"]>();
  for (const input of inputs) {
    const { adapter, plan } = await validateEvidencePlan(
      { ...input, idempotency_key: request.idempotency_key },
      planOrigin,
    );
    reconciliationCapabilities.add(adapter.reconciliationCapability);
    for (const sourceRequest of plan.requests) {
      if (requestIds.has(sourceRequest.id)) {
        throw new AdministrationProblem(
          422,
          "invalid_parameter",
          "Source Request identities must be unique across all Evidence Plans.",
        );
      }
      requestIds.add(sourceRequest.id);
    }
    plans.push(plan);
  }
  if (reconciliationCapabilities.size > 1) {
    throw new AdministrationProblem(
      422,
      "heterogeneous_reconciliation_coverage",
      "One Evidence Plan cannot mix Errata-only and complete Catalogue coverage.",
    );
  }
  return plans;
}

export async function representationFingerprint(input: {
  method: "GET";
  url: string;
  headers: Record<string, string>;
}): Promise<string> {
  return sha256(utf8(canonicalJson(input)));
}

export async function officialCollectionRequestsFromDiscovery(
  adapter: SourceAdapterRegistration,
  records: readonly unknown[],
  inheritedHeaders: Readonly<Record<string, string>> = {},
): Promise<OfficialSourceCollectionRequest[]> {
  if (
    adapter.requestUrlForDiscovery === undefined ||
    adapter.requestUrlForSurface === undefined ||
    adapter.requiredSurfaces === undefined
  ) {
    throw new Error("The Source Adapter has no complete Official Source discovery contract.");
  }
  if (records.length !== adapter.requiredSurfaces.length) {
    throw new AdministrationProblem(
      422,
      "source_discovery_failed",
      "Official Source discovery omitted required collection surfaces.",
    );
  }
  const requests: OfficialSourceCollectionRequest[] = [];
  for (const [index, surface] of adapter.requiredSurfaces.entries()) {
    const record = records[index];
    const expectedId = `${adapter.sourceLineage}:${surface}`;
    const discoveredUrl =
      isRecord(record) && typeof record.url === "string"
        ? assertOfficialSourceUrl(record.url, requiredOfficialSourceContract(adapter)).href
        : null;
    if (
      !isRecord(record) ||
      Object.keys(record).sort().join(",") !== "discovered_from,headers,id,method,surface,url" ||
      record.id !== expectedId ||
      record.surface !== surface ||
      record.method !== "GET" ||
      discoveredUrl === null ||
      !isRecord(record.headers) ||
      canonicalJson(record.headers) !== canonicalJson({ accept: "text/html" }) ||
      !isRecord(record.discovered_from) ||
      Object.keys(record.discovered_from).sort().join(",") !== "kind,label,resolution,url" ||
      record.discovered_from.kind !== "publisher_navigation" ||
      typeof record.discovered_from.label !== "string" ||
      record.discovered_from.label.length === 0 ||
      typeof record.discovered_from.url !== "string" ||
      typeof record.discovered_from.resolution !== "string" ||
      resolvedDiscoveryUrl(record.discovered_from) !== discoveredUrl
    ) {
      throw new AdministrationProblem(
        422,
        "source_discovery_failed",
        "Official Source discovery does not match its exact bounded collection contract.",
      );
    }
    const headers = officialCollectionRequestHeaders(surface, {
      ...(record.headers as Record<string, string>),
      ...inheritedHeaders,
    });
    assertBoundedOfficialSourceRequest(discoveredUrl, headers, true);
    requests.push({
      id: expectedId,
      surface,
      method: "GET",
      url: discoveredUrl,
      headers,
      representation_fingerprint: await representationFingerprint({
        method: "GET",
        url: discoveredUrl,
        headers,
      }),
    });
  }
  return requests;
}

function officialCollectionRequestHeaders(
  surface: string,
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  const baseUserAgent = headers["user-agent"] ?? "card-keepr-official-source/1";
  const canonicalUserAgent = canonicalOfficialSourceUserAgent(baseUserAgent) || "card-keepr-official-source/1";
  return {
    ...headers,
    "user-agent": `${canonicalUserAgent}; request-role=surface; request-surface=${surface}`,
  };
}

function canonicalOfficialSourceUserAgent(value: string): string {
  return value
    .split(";")
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && !/^request-(?:role|surface)=/iu.test(token))
    .join("; ");
}

export async function completeOfficialCollectionRequestsFromDiscovery(
  adapter: SourceAdapterRegistration,
  records: readonly unknown[],
  inheritedHeaders: Readonly<Record<string, string>> = {},
): Promise<OfficialSourceCollectionRequest[] | null> {
  if (adapter.requiredSurfaces === undefined) {
    throw new Error("The Source Adapter has no required surface vocabulary.");
  }
  const finalRecords: unknown[] = [];
  for (const surface of adapter.requiredSurfaces) {
    const matches = records.filter((record) => isRecord(record) && record.surface === surface);
    if (matches.length === 0) return null;
    if (matches.length !== 1) {
      throw new AdministrationProblem(
        422,
        "source_discovery_failed",
        `Official Source discovery duplicates the ${surface} surface.`,
      );
    }
    const match = matches[0]!;
    if (isRecord(match) && isRecord(match.discovered_from) && match.discovered_from.kind === "retained_stage_request") {
      const seed = records.find(
        (record) =>
          isRecord(record) &&
          typeof record.surface === "string" &&
          record.surface.startsWith("@seed:") &&
          record.url === match.url &&
          isRecord(record.discovered_from) &&
          record.discovered_from.kind === "publisher_navigation",
      );
      if (!isRecord(seed) || !isRecord(seed.discovered_from)) {
        throw new AdministrationProblem(
          422,
          "source_discovery_failed",
          `Official Source discovery did not retain the parent link for ${surface}.`,
        );
      }
      finalRecords.push({
        ...match,
        discovered_from: seed.discovered_from,
      });
    } else {
      finalRecords.push(match);
    }
  }
  return officialCollectionRequestsFromDiscovery(adapter, finalRecords, inheritedHeaders);
}

function resolvedDiscoveryUrl(discovery: Record<string, unknown>): string | null {
  try {
    return new URL(discovery.resolution as string, discovery.url as string).href;
  } catch {
    return null;
  }
}

export function parseEvidencePlan(json: string): EvidencePlan {
  const value: unknown = JSON.parse(json);
  if (
    !isRecord(value) ||
    typeof value.supported_game !== "string" ||
    typeof value.source_lineage !== "string" ||
    typeof value.game_profile_version !== "string" ||
    typeof value.adapter_version !== "string" ||
    !Array.isArray(value.requests)
  ) {
    throw new Error("Stored ingestion evidence plan is invalid");
  }
  const requests = value.requests.map((item): EvidencePlanRequest => {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.url !== "string" ||
      item.method !== "GET" ||
      !isRecord(item.headers) ||
      typeof item.representation_fingerprint !== "string" ||
      Object.values(item.headers).some((header) => typeof header !== "string")
    ) {
      throw new Error("Stored ingestion evidence plan is invalid");
    }
    return {
      id: item.id,
      url: item.url,
      method: "GET",
      headers: item.headers as Record<string, string>,
      representation_fingerprint: item.representation_fingerprint,
    };
  });
  return {
    supported_game: value.supported_game,
    source_lineage: value.source_lineage,
    game_profile_version: value.game_profile_version,
    adapter_version: value.adapter_version,
    requests,
  };
}

export function parseEvidencePlans(json: string): EvidencePlan[] {
  const value: unknown = JSON.parse(json);
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Array.isArray((value as { plans?: unknown }).plans)
  ) {
    const plans = (value as { plans: unknown[] }).plans.map((plan) => parseEvidencePlan(JSON.stringify(plan)));
    if (plans.length === 0) {
      throw new Error("Stored ingestion evidence plan is invalid");
    }
    return plans;
  }
  return [parseEvidencePlan(json)];
}

export function assertIdentifier(value: string, field: string): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(value)
  ) {
    throw new AdministrationProblem(422, "invalid_parameter", `${field} is not a valid opaque identity.`);
  }
}

export function validOfficialSourceUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AdministrationProblem(422, "invalid_parameter", "Official Source request URL is invalid.");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new AdministrationProblem(
      422,
      "invalid_parameter",
      "Official Source request URLs must be credential-free HTTPS URLs.",
    );
  }
  return url;
}

export function parseStringRecord(json: string): Record<string, string> {
  const value: unknown = JSON.parse(json);
  if (!isRecord(value) || Object.values(value).some((item) => typeof item !== "string")) {
    throw new Error("Stored header metadata is invalid");
  }
  return value as Record<string, string>;
}

export function headersRecord(headers: Headers): Record<string, string> {
  return Object.fromEntries([...headers.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

export function responseVary(headers: Headers): string[] {
  const vary = headers.get("vary");
  if (vary === null) return [];
  return [...new Set(vary.split(",").map((name) => name.trim().toLowerCase()))]
    .filter((name) => name.length > 0)
    .sort();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
