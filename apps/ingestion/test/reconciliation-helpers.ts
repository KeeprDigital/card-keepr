import {
  applyD1Migrations,
  env,
  type D1Migration,
} from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, expect } from "vitest";
import { installWorkflowIsolation } from "./workflow-isolation";
import { injectFixtureEvidencePlan } from "./fixture-plan-injection";
import type { StartEvidenceRunRequest } from "../../../src/catalogue/source-evidence";

export const testEnv = env as Env & {
  TEST_MIGRATIONS: D1Migration[];
};

let requestSequence = 0;

export function installReconciliationSuite(): void {
  installWorkflowIsolation();

  beforeEach(async () => {
    await applyD1Migrations(
      testEnv.CATALOGUE_DB,
      testEnv.TEST_MIGRATIONS,
    );
  });

  afterEach(async () => {
    await testEnv.CATALOGUE_DB.batch([
      testEnv.CATALOGUE_DB.prepare(
        `UPDATE ingestion_runs
         SET state = 'failed',
             terminal_at = COALESCE(candidate_created_at, started_at),
             failure_code = CASE WHEN state = 'publishing'
               THEN 'publication_abandoned'
               ELSE 'test_cleanup_active_run'
             END,
             progress_json = json_set(progress_json, '$.current_stage', 'failed')
         WHERE id = (
           SELECT active_ingestion_run_id FROM operation_state
           WHERE singleton = 1
         ) AND state IN (
           'planning', 'collecting', 'parsing', 'reconciling',
           'awaiting_approval', 'publishing'
         )`,
      ),
      testEnv.CATALOGUE_DB.prepare(
        `UPDATE operation_state
         SET active_ingestion_run_id = NULL,
             active_production_release_id = NULL,
             active_production_release_expires_at = NULL,
             recovery_health = 'healthy'
         WHERE singleton = 1`,
      ),
      testEnv.CATALOGUE_DB.prepare(
        `UPDATE curated_revisions
         SET status = 'retired', event_version = event_version + 1
         WHERE status IN ('active', 'reconfirmation_required')`,
      ),
    ]);
  });
}

export async function collect(
  path: string,
  key: string,
  source?: { game: string; lineage: string; adapter: string },
  waitTimeoutMs = 15_000,
): Promise<{
  id: string;
  document: Record<string, unknown>;
}> {
  const started = await postFixtureEvidence({
    supported_game: source?.game ?? "one-piece",
    source_lineage: source?.lineage ?? "one-piece-en",
    adapter_version: source?.adapter ?? "fixture-one-piece-json@3",
    idempotency_key: key,
    requests: [
      {
        id: "cards",
        method: "GET",
        url: `https://official-source.invalid${path}`,
        headers: { accept: "application/json" },
      },
    ],
  });
  expect(started.response.status).toBe(201);
  const id = requiredString(started.document, "id");
  const resumed = await post(
    `/v1/ingestion-runs/${id}/collection/resume`,
    {},
  );
  expect(resumed.response.status).toBe(202);
  const document = await waitForRunState(id, "parsing", waitTimeoutMs);
  return { id, document };
}

export async function collectRequests(
  requests: readonly { id: string; scenario: string }[],
  key: string,
): Promise<{ id: string; document: Record<string, unknown> }> {
  const started = await postFixtureEvidence({
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@3",
    idempotency_key: key,
    requests: requests.map((request) => ({
      id: request.id,
      method: "GET" as const,
      url: `https://official-source.invalid/reconciliation/${request.scenario}`,
      headers: { accept: "application/json" },
    })),
  });
  expect(started.response.status).toBe(201);
  const id = requiredString(started.document, "id");
  const resumed = await post(
    `/v1/ingestion-runs/${id}/collection/resume`,
    {},
  );
  expect(resumed.response.status).toBe(202);
  return { id, document: await waitForRunState(id, "parsing") };
}

export async function expectRetainedEvidenceInvalid(
  runId: string,
  detail: string,
): Promise<void> {
  const blocked = await reconcile(runId);
  expect(blocked.response.status).toBe(409);
  expect(blocked.document).toMatchObject({
    publishable: false,
    state: "failed",
    diagnostics: [
      expect.objectContaining({
        code: "retained_evidence_invalid",
        detail: expect.stringContaining(detail),
      }),
    ],
  });
}

export async function waitForRunState(
  id: string,
  expectedState: string,
  timeoutMs = 15_000,
  pollIntervalMs = 25,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const shown = await get(`/v1/ingestion-runs/${id}`);
    if (shown.document.state === expectedState) {
      return shown.document;
    }
    if (shown.document.state === "failed") {
      throw new Error(`collection failed: ${JSON.stringify(shown.document)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`run ${id} did not reach ${expectedState}`);
}

export async function reconcile(
  runId: string,
  extraHeaders: Record<string, string> = {},
  timeoutMs = 15_000,
) {
  const shown = await get(`/v1/ingestion-runs/${runId}`);
  const expectedCurrentRevisionId = requiredString(
    shown.document,
    "expected_current_revision_id",
  );
  const body = {
    expected_current_revision_id: expectedCurrentRevisionId,
    idempotency_key: `reconcile-${runId}`,
  };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const observed = await post(
      `/v1/ingestion-runs/${runId}/reconciliation`,
      body,
      extraHeaders,
    );
    if (
      observed.response.status !== 200 &&
      observed.response.status !== 202
    ) {
      return observed;
    }
    if (
      observed.document.status === "complete" &&
      observed.document.output !== null &&
      typeof observed.document.output === "object" &&
      !Array.isArray(observed.document.output)
    ) {
      const document = observed.document.output as Record<string, unknown>;
      return {
        response: new Response(null, {
          status: document.publishable === true ? 200 : 409,
        }),
        document,
        workflow_instance_id: requiredString(
          observed.document,
          "workflow_instance_id",
        ),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`reconciliation Workflow ${runId} did not complete`);
}

export function approve(document: Record<string, unknown>) {
  return post(
    `/v1/ingestion-runs/${requiredString(document, "run_id")}/approval`,
    {
      candidate_digest: requiredString(document, "candidate_digest"),
      expected_current_revision_id: requiredString(
        document,
        "expected_current_revision_id",
      ),
      idempotency_key: `approve-${crypto.randomUUID()}`,
    },
  );
}

export function get(pathname: string) {
  return request(pathname);
}

export function post(
  pathname: string,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
) {
  return request(pathname, body, extraHeaders);
}

export async function postFixtureEvidence(body: StartEvidenceRunRequest) {
  const document = await injectFixtureEvidencePlan(
    testEnv.CATALOGUE_DB,
    body,
  );
  return {
    response: new Response(null, { status: 201 }),
    document,
  };
}

export async function request(
  pathname: string,
  body?: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): Promise<{
  response: Response;
  document: Record<string, unknown>;
}> {
  const rpcResponse = await exports.default.fetch(
    new Request(`https://card-keepr.invalid${pathname}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: "Bearer vitest-administration-key",
        "cf-connecting-ip": `203.0.113.${(requestSequence++ % 250) + 1}`,
        ...(body === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const status = rpcResponse.status;
  const document =
    (await rpcResponse.json()) as Record<string, unknown>;
  return {
    response: new Response(null, { status }),
    document,
  };
}

export function requiredFirst(
  document: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const values = document[field];
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${field} is empty`);
  }
  const value = values[0];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field}[0] is invalid`);
  }
  return value as Record<string, unknown>;
}

export function requiredString(
  document: Record<string, unknown>,
  field: string,
): string {
  const value = document[field];
  if (typeof value !== "string") throw new Error(`${field} is not a string`);
  return value;
}

export function requiredRecord(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} is not an object`);
  }
  return value as Record<string, unknown>;
}

export async function exportComponentRecords(
  revisionId: string,
  componentName: string,
): Promise<Record<string, unknown>[]> {
  const exportRow = await testEnv.CATALOGUE_DB.prepare(
    `SELECT manifest_key FROM catalogue_exports
     WHERE catalogue_revision_id = ? AND verified = 1`,
  )
    .bind(revisionId)
    .first<{ manifest_key: string }>();
  const manifestObject = await testEnv.CATALOGUE_EXPORTS.get(
    exportRow?.manifest_key ?? "",
  );
  const manifest = await manifestObject?.json<{
    components: {
      name: string;
      compressed_sha256: string;
    }[];
  }>();
  const component = manifest?.components.find(
    (entry) => entry.name === componentName,
  );
  const object = await testEnv.CATALOGUE_EXPORTS.get(
    `catalogue-exports/${revisionId}/components/${component?.compressed_sha256}.ndjson.gz`,
  );
  if (object === null) throw new Error("export component missing");
  const decompressed = object.body.pipeThrough(
    new DecompressionStream("gzip"),
  );
  const text = await new Response(decompressed).text();
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export async function exportManifest(revisionId: string): Promise<{
  published_at: string;
  source_freshness: {
    game: string;
    area: string;
    checked_at: string;
  }[];
  components: {
    name: string;
    uncompressed_bytes: number;
    compressed_bytes: number;
    compressed_sha256: string;
  }[];
}> {
  const exportRow = await testEnv.CATALOGUE_DB.prepare(
    `SELECT manifest_key FROM catalogue_exports
     WHERE catalogue_revision_id = ? AND verified = 1`,
  )
    .bind(revisionId)
    .first<{ manifest_key: string }>();
  const manifestObject = await testEnv.CATALOGUE_EXPORTS.get(
    exportRow?.manifest_key ?? "",
  );
  if (manifestObject === null) throw new Error("export manifest missing");
  return manifestObject.json();
}
