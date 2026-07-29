import { canonicalJson, sha256, utf8 } from "./serialization";
import {
  assertAdapterBinding,
  requiredSourceAdapter,
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

export type StartEvidenceRunRequest = {
  supported_game: string;
  source_lineage: string;
  adapter_version: string;
  idempotency_key: string;
  requests: readonly {
    id: string;
    url: string;
    method?: string;
    headers?: Record<string, string>;
  }[];
};

export async function validateEvidencePlan(
  request: StartEvidenceRunRequest,
): Promise<{
  plan: EvidencePlan;
  adapter: SourceAdapterRegistration;
}> {
  assertIdentifier(request.supported_game, "supported_game");
  assertIdentifier(request.source_lineage, "source_lineage");
  assertIdentifier(request.adapter_version, "adapter_version");
  assertIdentifier(request.idempotency_key, "idempotency_key");
  const adapter = requiredSourceAdapter(request.adapter_version);
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
