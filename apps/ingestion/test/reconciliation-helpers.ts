import { applyD1Migrations, type D1Migration, env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, expect } from "vitest";
import { catalogueRoutes } from "../../../src/catalogue/read";
import { canonicalJson, catalogueStore, sha256, sha256Text } from "../../../src/catalogue/shared";
import type { StartEvidenceRunRequest } from "../../../src/catalogue/source-evidence";
import { routeTable } from "../../../src/http/routes";
import { collectFixtureEvidence } from "../../../test/support/fixture-evidence-plan";
import { injectFixtureEvidencePlan } from "./fixture-plan-injection";
import * as catalogueExportQueries from "./query-helpers/catalogue-export";
import * as curatedQueries from "./query-helpers/curated";
import * as ingestionQueries from "./query-helpers/ingestion";
import { installWorkflowIsolation } from "./workflow-isolation";

export const testEnv = env as Env & {
  TEST_MIGRATIONS: D1Migration[];
};

let requestSequence = 0;

export function installReconciliationSuite(): void {
  installWorkflowIsolation();

  beforeEach(async () => {
    await applyD1Migrations(testEnv.CATALOGUE_DB, testEnv.TEST_MIGRATIONS);
  });

  afterEach(async () => {
    const activeRunId = await ingestionQueries
      .readOperationStateActiveIngestionRunId(testEnv.CATALOGUE_DB)
      .first<string>("active_ingestion_run_id");
    await catalogueStore(testEnv.CATALOGUE_DB).batch([
      ingestionQueries.setIngestionRunsStateTerminalAtForCuratedRevisions(testEnv.CATALOGUE_DB).bind(activeRunId ?? ""),
      ingestionQueries.setOperationStateActiveIngestionRunIdActiveProductionReleaseId(testEnv.CATALOGUE_DB),
      curatedQueries.setCuratedRevisionsStatusEventVersion(testEnv.CATALOGUE_DB),
    ]);
  });
}

export async function collect(
  path: string,
  key: string,
  source?: { game: string; lineage: string; adapter: string },
  waitTimeoutMs = 15_000,
  completionState: "parsing" | "failed" = "parsing",
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
  await collectFixtureEvidence(testEnv.CATALOGUE_DB, testEnv.EVIDENCE_OBJECTS, testEnv.OFFICIAL_SOURCE_TRANSPORT, id);
  const document = await waitForRunState(id, completionState, waitTimeoutMs);
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
  await collectFixtureEvidence(testEnv.CATALOGUE_DB, testEnv.EVIDENCE_OBJECTS, testEnv.OFFICIAL_SOURCE_TRANSPORT, id);
  return { id, document: await waitForRunState(id, "parsing") };
}

export async function expectRetainedEvidenceInvalid(runId: string, detail: string): Promise<void> {
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
  let lastDocument: Record<string, unknown> | undefined;
  while (Date.now() < deadline) {
    const shown = await get(`/v1/ingestion-runs/${id}`);
    lastDocument = shown.document;
    if (shown.document.state === expectedState) {
      return shown.document;
    }
    if (shown.document.state === "failed") {
      throw new Error(`collection failed: ${JSON.stringify(shown.document)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`run ${id} did not reach ${expectedState}: ${JSON.stringify(lastDocument)}`);
}

export async function reconcile(runId: string, extraHeaders: Record<string, string> = {}, timeoutMs = 15_000) {
  const shown = await get(`/v1/ingestion-runs/${runId}`);
  const expectedCurrentRevisionId = requiredString(shown.document, "expected_current_revision_id");
  const body = {
    expected_current_revision_id: expectedCurrentRevisionId,
    idempotency_key: `reconcile-${runId}`,
  };
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const observed = await post(`/v1/ingestion-runs/${runId}/reconciliation`, body, extraHeaders);
    if (observed.response.status !== 200 && observed.response.status !== 202) {
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
        workflow_instance_id: requiredString(observed.document, "workflow_instance_id"),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`reconciliation Workflow ${runId} did not complete`);
}

export function approve(document: Record<string, unknown>) {
  return post(`/v1/ingestion-runs/${requiredString(document, "run_id")}/approval`, {
    candidate_digest: requiredString(document, "candidate_digest"),
    expected_current_revision_id: requiredString(document, "expected_current_revision_id"),
    idempotency_key: `approve-${crypto.randomUUID()}`,
  });
}

export function get(pathname: string) {
  return request(pathname);
}

export function post(pathname: string, body: Record<string, unknown>, extraHeaders: Record<string, string> = {}) {
  return request(pathname, body, extraHeaders);
}

export async function postFixtureEvidence(body: StartEvidenceRunRequest) {
  const document = await injectFixtureEvidencePlan(testEnv.CATALOGUE_DB, body);
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
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const status = rpcResponse.status;
  const document = (await rpcResponse.json()) as Record<string, unknown>;
  return {
    response: new Response(null, { status }),
    document,
  };
}

export function requiredFirst(document: Record<string, unknown>, field: string): Record<string, unknown> {
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

export function requiredString(document: Record<string, unknown>, field: string): string {
  const value = document[field];
  if (typeof value !== "string") throw new Error(`${field} is not a string`);
  return value;
}

export function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} is not an object`);
  }
  return value as Record<string, unknown>;
}

export async function exportComponentRecords(
  revisionId: string,
  componentName: string,
): Promise<Record<string, unknown>[]> {
  const exportRow = await catalogueExportQueries
    .readCatalogueExportsManifestKeyForExportComponentRecords(testEnv.CATALOGUE_DB)
    .bind(revisionId)
    .first<{ manifest_key: string }>();
  const manifestObject = await testEnv.CATALOGUE_EXPORTS.get(exportRow?.manifest_key ?? "");
  const manifest = await manifestObject?.json<{
    components: {
      name: string;
      compressed_sha256: string;
    }[];
  }>();
  if (manifest !== undefined && !("components" in manifest)) {
    return nativeExportComponentRecords(revisionId, componentName);
  }
  const component = manifest?.components.find((entry) => entry.name === componentName);
  const object = await testEnv.CATALOGUE_EXPORTS.get(
    `catalogue-exports/${revisionId}/components/${component?.compressed_sha256}.ndjson.gz`,
  );
  if (object === null) throw new Error("export component missing");
  const decompressed = object.body.pipeThrough(new DecompressionStream("gzip"));
  const text = await new Response(decompressed).text();
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

type ExportFixtureManifest = {
  published_at: string;
  source_freshness?: { game: string; area: string; checked_at: string }[];
  components: {
    name: string;
    kind?: string;
    records: number;
    uncompressed_bytes: number;
    content_sha256: string;
    compressed_bytes: number;
    compressed_sha256: string;
  }[];
  page?: { next_cursor: string | null };
  manifest_sha256: string;
};

/** Native manifests remain honest pages; callers inspecting all bytes must follow the cursor. */
export async function exportManifest(revisionId: string): Promise<ExportFixtureManifest> {
  const exportRow = await catalogueExportQueries
    .readCatalogueExportsManifestKeyForExportComponentRecords(testEnv.CATALOGUE_DB)
    .bind(revisionId)
    .first<{ manifest_key: string }>();
  const manifestObject = await testEnv.CATALOGUE_EXPORTS.get(exportRow?.manifest_key ?? "");
  if (manifestObject === null) throw new Error("export manifest missing");
  const manifest = await manifestObject.json<ExportFixtureManifest>();
  return "components" in manifest ? manifest : nativeExportManifestPage(revisionId, null);
}

const dispatchExportRead = routeTable(catalogueRoutes);
async function exportRead(path: string) {
  const request = new Request(`https://card-keepr.invalid${path}`);
  const response = await dispatchExportRead("GET", new URL(request.url).pathname, {
    request,
    env: { ...testEnv, CATALOGUE_DB: catalogueStore(testEnv.CATALOGUE_DB) },
    requestId: "fixture-export-read",
    base: { origin: "https://card-keepr.invalid", basePath: "" },
  });
  if (response === null || response.status !== 200) throw new Error(`Export read failed: ${path}`);
  return response;
}

async function nativeExportManifestPage(revisionId: string, after: string | null) {
  const response = await exportRead(
    `/v1/catalogue-exports/${revisionId}${after === null ? "" : `?after=${encodeURIComponent(after)}`}`,
  );
  const { data } = await response.json<{ data: ExportFixtureManifest }>();
  expect(await sha256Text(canonicalJson({ ...data, manifest_sha256: "0".repeat(64) }))).toBe(data.manifest_sha256);
  return data;
}

async function nativeExportComponentRecords(revisionId: string, kind: string) {
  const records: Record<string, unknown>[] = [];
  let after: string | null = null;
  const visited = new Set<string>();
  do {
    const manifest = await nativeExportManifestPage(revisionId, after);
    for (const component of manifest.components.filter((component) => component.kind === kind)) {
      const response = await exportRead(`/v1/catalogue-exports/${revisionId}/components/${component.name}`);
      const compressed = new Uint8Array(await response.arrayBuffer());
      expect(compressed.byteLength).toBe(component.compressed_bytes);
      expect(await sha256(compressed)).toBe(component.compressed_sha256);
      const raw = new Uint8Array(
        await new Response(new Response(compressed).body!.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer(),
      );
      expect(raw.byteLength).toBe(component.uncompressed_bytes);
      expect(await sha256(raw)).toBe(component.content_sha256);
      const values = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false })
        .decode(raw)
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(values).toHaveLength(component.records);
      records.push(...values);
    }
    after = manifest.page?.next_cursor ?? null;
    if (after !== null) {
      expect(visited.has(after)).toBe(false);
      visited.add(after);
    }
  } while (after !== null);
  return records;
}
