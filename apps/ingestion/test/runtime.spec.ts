import { env, exports } from "cloudflare:workers";
import {
  applyD1Migrations,
  type D1Migration,
} from "cloudflare:test";
import { beforeEach, expect, test } from "vitest";

declare global {
  interface __BaseEnv_Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}

beforeEach(async () => {
  await applyD1Migrations(
    env.CATALOGUE_DB,
    env.TEST_MIGRATIONS,
  );
});

test("the administration authentication boundary runs in the Workers runtime", async () => {
  const response = await exports.default.fetch(
    new Request("https://card-keepr.invalid/health", {
      headers: { authorization: "Bearer vitest-administration-key" },
    }),
  );

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    contract: "card-keepr-runtime-health@1",
    runtime: "ingestion",
    status: "ok",
  });
});

test("a successful Official Source response is snapshotted before parsing", async () => {
  const created = await administrationRequest(
    "/v1/source-collections",
    "POST",
    {
      supported_game: "one-piece",
      source_lineage: "one-piece-en",
      adapter_version: "json-document@1",
      idempotency_key: "source_collection_success_001",
      requests: [
        {
          id: "cards",
          url: "https://official-source.invalid/cards",
        },
      ],
    },
  );
  expect(created.status).toBe(201);
  const planned = await created.json<{
    id: string;
    state: string;
  }>();
  expect(planned.state).toBe("collecting");

  const resumed = await administrationRequest(
    `/v1/source-collections/${planned.id}/resume`,
    "POST",
  );
  expect(resumed.status).toBe(200);
  const completed = await resumed.json<{
    state: string;
    snapshots: {
      id: string;
      request: { method: string; url: string };
      retrieval: { retrieved_at: string; fetch_attempt_id: string };
      http: {
        status: number;
        headers: Record<string, string>;
      };
      content: {
        digest: string;
        byte_length: number;
        object_key: string;
      };
      adapter_version: string;
      ingestion_run_id: string;
    }[];
    observation_sets: {
      id: string;
      source_snapshot_id: string;
      adapter_version: string;
      content_digest: string;
      object_key: string;
      observation_count: number;
    }[];
  }>();

  expect(completed.state).toBe("succeeded");
  expect(completed.snapshots).toHaveLength(1);
  const snapshot = completed.snapshots[0];
  if (snapshot === undefined) throw new Error("missing Source Snapshot");
  expect(snapshot).toMatchObject({
    request: {
      method: "GET",
      url: "https://official-source.invalid/cards",
    },
    http: {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        etag: '"cards-v1"',
      },
    },
    adapter_version: "json-document@1",
    ingestion_run_id: planned.id,
  });
  expect(snapshot.content).toMatchObject({
    byte_length: 60,
  });
  expect(snapshot.content.digest).toMatch(
    /^[a-f0-9]{64}$/,
  );
  expect(snapshot.content.object_key).toBe(
    `source-snapshots/sha256/${snapshot.content.digest}`,
  );

  expect(completed.observation_sets).toHaveLength(1);
  const observationSet = completed.observation_sets[0];
  if (observationSet === undefined) {
    throw new Error("missing Source Observation set");
  }
  expect(observationSet).toMatchObject({
    source_snapshot_id: snapshot.id,
    adapter_version: "json-document@1",
    observation_count: 1,
  });
  expect(observationSet.content_digest).toMatch(
    /^[a-f0-9]{64}$/,
  );
  expect(observationSet.object_key).toMatch(
    /^source-observations\/srcobsset_[A-Za-z0-9-]+\.json$/,
  );

  const snapshotContent = await administrationRequest(
    `/v1/source-snapshots/${snapshot.id}/content`,
    "GET",
  );
  expect(snapshotContent.status).toBe(200);
  expect(snapshotContent.headers.get("etag")).toBe(
    `"sha256-${snapshot.content.digest}"`,
  );
  await expect(snapshotContent.text()).resolves.toBe(
    '{"cards":[{"card_number":"OP01-001","name":"Roronoa Zoro"}]}',
  );

  const observationContent = await administrationRequest(
    `/v1/source-observation-sets/${observationSet.id}/content`,
    "GET",
  );
  expect(observationContent.status).toBe(200);
  const observationDocument = await observationContent.json<{
    source_snapshot_id: string;
    adapter_version: string;
    observations: unknown[];
  }>();
  expect(observationDocument).toMatchObject({
    source_snapshot_id: snapshot.id,
    adapter_version: "json-document@1",
  });
  expect(observationDocument.observations).toHaveLength(1);

  const shown = await administrationRequest(
    `/v1/source-collections/${planned.id}`,
    "GET",
  );
  expect(shown.status).toBe(200);
  await expect(shown.json()).resolves.toEqual(completed);
});

test("redirects and terminal HTTP failures remain diagnostics without Source Snapshots", async () => {
  const redirectRun = await createCollection(
    "source_collection_redirect_001",
    "https://official-source.invalid/redirect",
  );
  const rejectedResponse = await administrationRequest(
    `/v1/source-collections/${redirectRun.id}/resume`,
    "POST",
  );
  expect(rejectedResponse.status).toBe(200);
  const rejected = await rejectedResponse.json<CollectionDocument>();
  expect(rejected).toMatchObject({
    state: "failed",
    failure_code: "source_redirect_rejected",
    snapshots: [],
  });
  expect(rejected.diagnostics).toHaveLength(1);
  expect(rejected.diagnostics[0]).toMatchObject({
    attempt_number: 1,
    outcome: "redirect",
    http_status: 302,
  });

  const failedRun = await createCollection(
    "source_collection_failed_001",
    "https://failed-official-source.invalid/unavailable",
  );
  const failedResponse = await administrationRequest(
    `/v1/source-collections/${failedRun.id}/resume`,
    "POST",
  );
  expect(failedResponse.status).toBe(200);
  const failed = await failedResponse.json<CollectionDocument>();
  expect(failed).toMatchObject({
    state: "failed",
    failure_code: "source_request_retries_exhausted",
    snapshots: [],
  });
  expect(failed.diagnostics).toHaveLength(4);
  expect(
    failed.diagnostics.map((diagnostic) => ({
      attempt_number: diagnostic.attempt_number,
      outcome: diagnostic.outcome,
      status: diagnostic.http_status,
      retry_after_ms: diagnostic.retry_after_ms,
    })),
  ).toEqual([
    {
      attempt_number: 1,
      outcome: "http_failure",
      status: 503,
      retry_after_ms: 0,
    },
    {
      attempt_number: 2,
      outcome: "http_failure",
      status: 503,
      retry_after_ms: 0,
    },
    {
      attempt_number: 3,
      outcome: "http_failure",
      status: 503,
      retry_after_ms: 0,
    },
    {
      attempt_number: 4,
      outcome: "http_failure",
      status: 503,
      retry_after_ms: 0,
    },
  ]);

  const retriedResponse = await administrationRequest(
    `/v1/source-collections/${failed.id}/retry`,
    "POST",
    { idempotency_key: "source_collection_failed_retry_001" },
  );
  expect(retriedResponse.status).toBe(201);
  const retried = await retriedResponse.json<CollectionDocument>();
  expect(retried).toMatchObject({
    state: "collecting",
    linked_run_id: failed.id,
    snapshots: [],
    diagnostics: [],
  });
  expect(retried.id).not.toBe(failed.id);
});

test(
  "successful captures remain auditable when a later required response is rejected or terminally fails",
  async () => {
    for (const scenario of [
      {
        key: "retained_after_rejected_001",
        terminalUrl:
          "https://retained-redirect-official-source.invalid/redirect",
        failureCode: "source_redirect_rejected",
      },
      {
        key: "retained_after_terminal_failure_001",
        terminalUrl:
          "https://retained-failure-official-source.invalid/unavailable",
        failureCode: "source_request_retries_exhausted",
      },
    ]) {
      const response = await administrationRequest(
        "/v1/source-collections",
        "POST",
        {
          supported_game: "one-piece",
          source_lineage: "one-piece-en",
          adapter_version: "json-document@1",
          idempotency_key: scenario.key,
          requests: [
            {
              id: "captured",
              url: `https://${new URL(scenario.terminalUrl).hostname}/cards`,
            },
            { id: "terminal", url: scenario.terminalUrl },
          ],
        },
      );
      const run = await response.json<{ id: string }>();
      const terminal = await resumeCollection(run.id);
      expect(terminal).toMatchObject({
        state: "failed",
        failure_code: scenario.failureCode,
      });
      expect(terminal.snapshots).toHaveLength(1);
      expect(terminal.observation_sets).toHaveLength(1);

      const retained = await showCollection(run.id);
      expect(retained.snapshots).toEqual(terminal.snapshots);
      expect(retained.observation_sets).toEqual(
        terminal.observation_sets,
      );
    }
  },
  12_000,
);

test("a successful response remains snapshotted when parsing terminally fails", async () => {
  const run = await createCollection(
    "source_collection_parse_failure_001",
    "https://parse-failure-official-source.invalid/invalid-json",
  );
  const failed = await resumeCollection(run.id);
  expect(failed).toMatchObject({
    state: "failed",
    failure_code: "source_parse_failed",
  });
  expect(failed.snapshots).toHaveLength(1);
  expect(failed.observation_sets).toEqual([]);
  expect(failed.diagnostics).toHaveLength(1);
  expect(failed.diagnostics[0]).toMatchObject({
    outcome: "success",
    http_status: 200,
  });

  const retained = await showCollection(run.id);
  expect(retained.snapshots).toEqual(failed.snapshots);
});

test("validator revalidation creates fresh fetch evidence and reuses bytes only for the same adapter version", async () => {
  const firstRun = await createCollection(
    "source_collection_cache_first_001",
    "https://official-source.invalid/conditional",
  );
  const first = await resumeCollection(firstRun.id);
  const firstSnapshot = first.snapshots[0];
  if (firstSnapshot === undefined) throw new Error("missing first snapshot");

  const revalidatedRun = await createCollection(
    "source_collection_cache_second_001",
    "https://official-source.invalid/conditional",
  );
  const revalidated = await resumeCollection(revalidatedRun.id);
  const revalidatedSnapshot = revalidated.snapshots[0];
  if (revalidatedSnapshot === undefined) {
    throw new Error("missing revalidated snapshot");
  }
  expect(revalidatedSnapshot).toMatchObject({
    http: { status: 304 },
    reused_source_snapshot_id: firstSnapshot.id,
    content: {
      digest: firstSnapshot.content.digest,
      object_key: firstSnapshot.content.object_key,
    },
  });
  expect(revalidated.diagnostics[0]).toMatchObject({
    outcome: "cache_revalidated",
    http_status: 304,
  });

  const changedAdapterRun = await createCollection(
    "source_collection_cache_adapter_changed_001",
    "https://official-source.invalid/conditional",
    "json-document@2",
  );
  const changedAdapter = await resumeCollection(changedAdapterRun.id);
  const changedAdapterSnapshot = changedAdapter.snapshots[0];
  if (changedAdapterSnapshot === undefined) {
    throw new Error("missing changed-adapter snapshot");
  }
  expect(changedAdapterSnapshot.http.status).toBe(200);
  expect(changedAdapterSnapshot.reused_source_snapshot_id).toBeNull();
});

test("reparsing appends an immutable observation set tied to the exact Source Snapshot", async () => {
  const run = await createCollection(
    "source_collection_reparse_001",
    "https://official-source.invalid/cards",
  );
  const completed = await resumeCollection(run.id);
  const snapshot = completed.snapshots[0];
  const originalSet = completed.observation_sets[0];
  if (snapshot === undefined || originalSet === undefined) {
    throw new Error("missing evidence for reparse");
  }

  const reparseResponse = await administrationRequest(
    `/v1/source-snapshots/${snapshot.id}/observations`,
    "POST",
    { adapter_version: "json-document@2" },
  );
  expect(reparseResponse.status).toBe(201);
  const reparsed = await reparseResponse.json<ObservationSet>();
  expect(reparsed).toMatchObject({
    source_snapshot_id: snapshot.id,
    adapter_version: "json-document@2",
    observation_count: 1,
  });
  expect(reparsed.id).not.toBe(originalSet.id);
  expect(reparsed.object_key).not.toBe(originalSet.object_key);

  const shown = await showCollection(run.id);
  expect(shown.observation_sets).toHaveLength(2);
  expect(shown.observation_sets[0]).toEqual(originalSet);
  expect(shown.observation_sets[1]).toEqual(reparsed);
});

test("collection is sequential per hostname and different hostnames progress concurrently", async () => {
  const response = await administrationRequest(
    "/v1/source-collections",
    "POST",
    {
      supported_game: "one-piece",
      source_lineage: "one-piece-en",
      adapter_version: "json-document@1",
      idempotency_key: "source_collection_pacing_001",
      requests: [
        {
          id: "first-a",
          url: "https://pacing-a-official-source.invalid/sequence/1",
        },
        {
          id: "second-a",
          url: "https://pacing-a-official-source.invalid/sequence/2",
        },
        {
          id: "first-b",
          url: "https://pacing-b-official-source.invalid/sequence/1",
        },
        {
          id: "second-b",
          url: "https://pacing-b-official-source.invalid/sequence/2",
        },
      ],
    },
  );
  const run = await response.json<{ id: string }>();
  const completed = await resumeCollection(run.id);
  expect(completed.state).toBe("succeeded");
  const attempts = Object.fromEntries(
    completed.diagnostics.map((attempt) => [
      attempt.request_id,
      Date.parse(attempt.requested_at),
    ]),
  );
  expect(attempts["second-a"]! - attempts["first-a"]!).toBeGreaterThanOrEqual(
    1_000,
  );
  expect(attempts["second-b"]! - attempts["first-b"]!).toBeGreaterThanOrEqual(
    1_000,
  );
  expect(
    Math.abs(attempts["first-a"]! - attempts["first-b"]!),
  ).toBeLessThan(500);
});

function administrationRequest(
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

type Snapshot = {
  id: string;
  http: { status: number };
  content: { digest: string; object_key: string };
  reused_source_snapshot_id: string | null;
};

type ObservationSet = {
  id: string;
  source_snapshot_id: string;
  adapter_version: string;
  object_key: string;
  observation_count: number;
};

type Diagnostic = {
  request_id: string;
  attempt_number: number;
  requested_at: string;
  outcome: string;
  http_status: number | null;
  retry_after_ms: number | null;
};

type CollectionDocument = {
  id: string;
  state: string;
  linked_run_id: string | null;
  failure_code: string | null;
  snapshots: Snapshot[];
  observation_sets: ObservationSet[];
  diagnostics: Diagnostic[];
};

async function createCollection(
  idempotencyKey: string,
  url: string,
  adapterVersion = "json-document@1",
): Promise<CollectionDocument> {
  const response = await administrationRequest(
    "/v1/source-collections",
    "POST",
    {
      supported_game: "one-piece",
      source_lineage: "one-piece-en",
      adapter_version: adapterVersion,
      idempotency_key: idempotencyKey,
      requests: [{ id: "required-source", url }],
    },
  );
  expect(response.status).toBe(201);
  return response.json<CollectionDocument>();
}

async function resumeCollection(
  runId: string,
): Promise<CollectionDocument> {
  const response = await administrationRequest(
    `/v1/source-collections/${runId}/resume`,
    "POST",
  );
  expect(response.status).toBe(200);
  return response.json<CollectionDocument>();
}

async function showCollection(
  runId: string,
): Promise<CollectionDocument> {
  const response = await administrationRequest(
    `/v1/source-collections/${runId}`,
    "GET",
  );
  expect(response.status).toBe(200);
  return response.json<CollectionDocument>();
}
