import { env, exports } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";
import {
  startEvidenceRun,
} from "../../../src/catalogue/source-evidence-repository";
import {
  officialSourceDiscoveryRequests,
} from "../../../src/catalogue/product-release-source-adapters";
import {
  fusionWorldProductionCollectionRequests,
} from "./production-collection-request-goldens";

declare global {
  interface __BaseEnv_Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}

export function installRuntimeSuite(): void {
  beforeEach(async () => {
    await applyD1Migrations(
      env.CATALOGUE_DB,
      env.TEST_MIGRATIONS,
    );
    // Workflow instances outlive a Vitest request isolate. Reset only the
    // singleton lock so each test begins with an independent administration
    // scenario; production never performs this test-only setup.
    await env.CATALOGUE_DB.prepare(
      "UPDATE operation_state SET active_ingestion_run_id = NULL WHERE singleton = 1",
    ).run();
  });
}

export function fusionWorldDiscoveryRecords() {
  return fusionWorldProductionCollectionRequests.map((request) => ({
    id: request.id,
    surface: request.id.slice("fusion-world-en:".length),
    method: "GET" as const,
    url: request.url,
    headers: { accept: "text/html" },
    discovered_from: {
      kind: "publisher_navigation",
      label: request.id,
      url: request.url,
      resolution: "",
    },
  }));
}

export function administrationRequest(
  pathname: string,
  method: string,
  body?: unknown,
): Promise<Response> {
  return exports.default.fetch(
    new Request(`https://card-keepr.invalid${pathname}`, {
      method,
      headers: {
        authorization: "Bearer vitest-administration-key",
        "cf-connecting-ip": `192.0.2.${crypto.getRandomValues(new Uint8Array(1))[0]!}`,
        ...(body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

export type Snapshot = {
  id: string;
  request: { method: string; url: string };
  retrieval: { retrieved_at: string; fetch_attempt_id: string };
  http: { status: number; headers: Record<string, string> };
  content: { digest: string; object_key: string; byte_length: number };
  adapter_version: string;
  ingestion_run_id: string;
  reused_source_snapshot_id: string | null;
};

export type ObservationSet = {
  id: string;
  source_snapshot_id: string;
  adapter_version: string;
  content_digest: string;
  object_key: string;
  observation_count: number;
};

export type Diagnostic = {
  request_id: string;
  attempt_number: number;
  requested_at: string;
  outcome: string;
  http_status: number | null;
  retry_after_ms: number | null;
  diagnostic?: string | null;
};

export type CollectionDocument = {
  id: string;
  state: string;
  linked_run_id: string | null;
  failure_code: string | null;
  snapshots: Snapshot[];
  observation_sets: ObservationSet[];
  diagnostics: Diagnostic[];
  workflow: { parent_id: string | null; child_ids: string[] };
  official_source_collection_plans: Array<{
    source_lineage: string;
    discovery_observation_set_id: string;
    contract: string;
    content_digest: string;
    created_at: string;
    plan: {
      source_lineage: string;
      requests: Array<Record<string, unknown>>;
    };
  }>;
};

export async function createCollection(
  idempotencyKey: string,
  url: string,
  adapterVersion = "fixture-one-piece-json@1",
  headers: Record<string, string> = {},
): Promise<CollectionDocument> {
  const response = await fixtureEvidenceRequest(
    {
      supported_game: "one-piece",
      source_lineage: "one-piece-en",
      adapter_version: adapterVersion,
      idempotency_key: idempotencyKey,
      requests: [{ id: "required-source", url, headers }],
    },
  );
  expect(response.status).toBe(201);
  return response.json<CollectionDocument>();
}


export async function fixtureEvidenceRequest(body: {
  supported_game: string;
  source_lineage: string;
  adapter_version: string;
  idempotency_key: string;
  requests: {
    id: string;
    url: string;
    headers?: Record<string, string>;
  }[];
}): Promise<Response> {
  return Response.json(
    await startEvidenceRun(env.CATALOGUE_DB, body, "synthetic_fixture"),
    { status: 201 },
  );
}

export function exactOnePiecePlan(idempotencyKey: string) {
  return {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "one-piece-en@6",
    idempotency_key: idempotencyKey,
    requests: officialSourceDiscoveryRequests("one-piece-en").map(
      (request) => ({ ...request }),
    ),
  };
}

export async function waitForEvidenceDiagnostic(
  runId: string,
  timeoutMs = 2_000,
): Promise<CollectionDocument> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await showCollection(runId);
    if (current.diagnostics.length > 0) return current;
    if (Date.now() >= deadline) {
      throw new Error(`Ingestion Run ${runId} did not record a diagnostic`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export async function waitForEvidenceCondition(
  runId: string,
  condition: (current: CollectionDocument) => boolean,
  timeoutMs = 8_000,
): Promise<CollectionDocument> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await showCollection(runId);
    if (condition(current)) return current;
    if (Date.now() >= deadline) {
      throw new Error(
        `Ingestion Run ${runId} did not reach test condition: ${
          JSON.stringify(current)
        }`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export async function waitForWorkflowStatus(
  instanceId: string,
  readStatus: () => Promise<{ status: string }>,
  expectedStatus: string,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const status = await readStatus();
      if (status.status === expectedStatus) return;
    } catch {
      // The deterministic handle can exist before createBatch reaches it.
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Workflow ${instanceId} did not reach ${expectedStatus}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export async function waitForParseOperation(
  runId: string,
  expectedState: string,
  timeoutMs = 8_000,
): Promise<{ state: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const operation = await env.CATALOGUE_DB.prepare(
      `SELECT state FROM source_parse_operations
       WHERE intent = 'collection' AND source_snapshot_id IN (
         SELECT source_snapshot_id FROM source_requests
         WHERE ingestion_run_id = ?
       )`,
    )
      .bind(runId)
      .first<{ state: string }>();
    if (operation?.state === expectedState) return operation;
    if (Date.now() >= deadline) {
      throw new Error(
        `Parse operation for ${runId} did not reach ${expectedState}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export async function resumeCollection(
  runId: string,
  timeoutMs = 8_000,
): Promise<CollectionDocument> {
  const response = await administrationRequest(
    `/v1/ingestion-runs/${runId}/collection/resume`,
    "POST",
  );
  expect(response.status).toBe(202);
  await response.body?.cancel();
  return waitForEvidenceRun(runId, null, timeoutMs);
}

export async function waitForEvidenceRun(
  runId: string,
  expectedState: "parsing" | "awaiting_approval" | "failed" | null = null,
  timeoutMs = 8_000,
): Promise<CollectionDocument> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = await showCollection(runId);
    if (
      expectedState === null
        ? current.state === "parsing" || current.state === "failed"
        : expectedState === "awaiting_approval"
          ? current.state === "awaiting_approval" || current.state === "failed"
        : current.state === expectedState
    ) {
      return current;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Ingestion Run ${runId} did not reach ${expectedState ?? "a terminal collection-phase state"}; current state is ${current.state}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export function clearActiveRunForNextScenario(): Promise<D1Result<unknown>> {
  return env.CATALOGUE_DB.prepare(
    "UPDATE operation_state SET active_ingestion_run_id = NULL WHERE singleton = 1",
  ).run();
}

export async function showCollection(
  runId: string,
): Promise<CollectionDocument> {
  const response = await administrationRequest(
    `/v1/ingestion-runs/${runId}/evidence`,
    "GET",
  );
  expect(response.status).toBe(200);
  return response.json<CollectionDocument>();
}
