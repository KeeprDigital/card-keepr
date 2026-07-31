import { canonicalJson, sha256, utf8 } from "./serialization";
import {
  assertAdapterRequestSurface,
  assertAdapterBinding,
  requiredSourceAdapter,
  sourceAdapterRegistrations,
  type SourceAdapterRegistration,
} from "./source-adapters";
import { AdministrationProblem } from "./ingestion";

const allowedRequestHeaders = new Set([
  "accept",
  "accept-language",
  "user-agent",
]);

export type EvidencePlanRequest = {
  id: string;
  url: string;
  method: "GET";
  headers: Record<string, string>;
  representation_fingerprint: string;
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
  | (EvidencePlanInput & { idempotency_key: string })
  | {
      plans: readonly EvidencePlanInput[];
      idempotency_key: string;
    };

export type EvidenceParentWorkflowParams = {
  ingestion_run_id: string;
};

export type EvidenceHostWorkflowParams = {
  ingestion_run_id: string;
  hostname: string;
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
  const adapter = requiredSourceAdapter(request.adapter_version);
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
      headers[normalizedName] = value;
    }
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
  if (adapter.requiredSurfaces !== undefined) {
    const expectedIds = adapter.requiredSurfaces.map(
      (surface) => `${adapter.sourceLineage}:${surface}`,
    );
    const actualIds = requests.map(({ id }) => id);
    if (
      actualIds.length !== expectedIds.length ||
      expectedIds.some((id) => !requestIds.has(id))
    ) {
      throw new AdministrationProblem(
        422,
        "incomplete_source_plan",
        "The Evidence Plan must contain every exact required Official Source surface once.",
      );
    }
    if (adapter.requestUrlForSurface === undefined) {
      throw new Error(
        "A production adapter with required surfaces has no request-URL contract.",
      );
    }
    for (const sourceRequest of requests) {
      const surface = sourceRequest.id.slice(
        `${adapter.sourceLineage}:`.length,
      );
      if (
        new URL(sourceRequest.url).href !==
          new URL(adapter.requestUrlForSurface(surface)).href
      ) {
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

export async function validateEvidencePlans(
  request: StartEvidenceRunRequest,
  planOrigin: SourceAdapterRegistration["origin"] = "production",
): Promise<EvidencePlan[]> {
  assertIdentifier(request.idempotency_key, "idempotency_key");
  const inputs = "plans" in request ? request.plans : [request];
  if (inputs.length < 1 || inputs.length > 20) {
    throw new AdministrationProblem(
      422,
      "invalid_parameter",
      "plans must contain between 1 and 20 Evidence Plans.",
    );
  }
  const plans: EvidencePlan[] = [];
  const requestIds = new Set<string>();
  const reconciliationCapabilities = new Set<
    SourceAdapterRegistration["reconciliationCapability"]
  >();
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
  if (planOrigin === "production") {
    const requiredLineagesByGame = new Map<string, Set<string>>();
    for (const adapter of sourceAdapterRegistrations) {
      if (
        adapter.origin === "production" &&
        adapter.reconciliationCapability === "catalogue"
      ) {
        const lineages =
          requiredLineagesByGame.get(adapter.supportedGame) ?? new Set();
        lineages.add(adapter.sourceLineage);
        requiredLineagesByGame.set(adapter.supportedGame, lineages);
      }
    }
    for (const game of new Set(plans.map(({ supported_game }) => supported_game))) {
      const required = requiredLineagesByGame.get(game) ?? new Set();
      const supplied = new Set(
        plans
          .filter(({ supported_game }) => supported_game === game)
          .map(({ source_lineage }) => source_lineage),
      );
      if (
        required.size !== supplied.size ||
        [...required].some((lineage) => !supplied.has(lineage))
      ) {
        throw new AdministrationProblem(
          422,
          "incomplete_source_lineages",
          "Every accepted Official Source lineage for each selected Supported Game must be planned together.",
        );
      }
    }
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
    const plans = (value as { plans: unknown[] }).plans.map((plan) =>
      parseEvidencePlan(JSON.stringify(plan)),
    );
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
    throw new AdministrationProblem(
      422,
      "invalid_parameter",
      `${field} is not a valid opaque identity.`,
    );
  }
}

export function validOfficialSourceUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AdministrationProblem(
      422,
      "invalid_parameter",
      "Official Source request URL is invalid.",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
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
  if (
    !isRecord(value) ||
    Object.values(value).some((item) => typeof item !== "string")
  ) {
    throw new Error("Stored header metadata is invalid");
  }
  return value as Record<string, string>;
}

export function headersRecord(headers: Headers): Record<string, string> {
  return Object.fromEntries(
    [...headers.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
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
