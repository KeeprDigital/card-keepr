import { env, exports } from "cloudflare:workers";
import { expect, test } from "vitest";
import {
  administrationRequest,
  clearActiveRunForNextScenario,
  fixtureEvidenceRequest,
  installRuntimeSuite,
} from "./runtime-helpers";
import {
  fusionWorldRequestCapacity,
  pauseRunAtCapacity,
} from "./capacity-pause-helpers";

installRuntimeSuite();

const extensionBody = {
  expected_request_capacity: fusionWorldRequestCapacity,
  expected_capacity_generation: 1,
  request_capacity: 20_000,
  idempotency_key: "capacity_extension_001",
};

test("extending capacity advances the generation atomically and replays idempotently", async () => {
  const { runId } = await pauseRunAtCapacity("capacity_extension_run_001");

  const extended = await administrationRequest(
    `/v1/ingestion-runs/${runId}/capacity/extension`,
    "POST",
    extensionBody,
  );
  expect(extended.status).toBe(200);
  const document = await extended.json<Record<string, unknown>>();
  expect(document).toMatchObject({
    contract: "card-keepr-capacity-extension@1",
    ingestion_run_id: runId,
    source_lineage: "fusion-world-en",
    previous_request_capacity: fusionWorldRequestCapacity,
    previous_capacity_generation: 1,
    request_capacity: 20_000,
    capacity_generation: 2,
  });
  expect(typeof document.extended_at).toBe("string");

  // The extension is one immutable record that advanced the generation.
  const stored = await env.CATALOGUE_DB.prepare(
    `SELECT * FROM ingestion_run_capacity_extensions
     WHERE ingestion_run_id = ?`,
  ).bind(runId).all<Record<string, unknown>>();
  expect(stored.results).toHaveLength(1);
  expect(stored.results[0]).toMatchObject({
    capacity_generation: 2,
    previous_request_capacity: fusionWorldRequestCapacity,
    request_capacity: 20_000,
    source_lineage: "fusion-world-en",
    idempotency_key: "capacity_extension_001",
  });

  // The run stays paused with its immutable pause record: extension changes
  // capacity, collection resumes only through `source resume`.
  expect(await env.CATALOGUE_DB.prepare(
    "SELECT state FROM ingestion_runs WHERE id = ?",
  ).bind(runId).first("state")).toBe("paused");
  expect(await env.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count FROM ingestion_run_capacity_pauses
     WHERE ingestion_run_id = ?`,
  ).bind(runId).first("count")).toBe(1);

  // Replaying the same extension returns the original result without
  // applying another extension.
  const replayed = await administrationRequest(
    `/v1/ingestion-runs/${runId}/capacity/extension`,
    "POST",
    extensionBody,
  );
  expect(replayed.status).toBe(200);
  await expect(replayed.json()).resolves.toEqual(document);
  expect(await env.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count FROM ingestion_run_capacity_extensions
     WHERE ingestion_run_id = ?`,
  ).bind(runId).first("count")).toBe(1);
}, 30_000);

test("the capacity extension mutation requires the administration key", async () => {
  const response = await exports.default.fetch(
    new Request(
      "https://card-keepr.invalid/v1/ingestion-runs/run_unauthenticated/capacity/extension",
      {
        method: "POST",
        headers: {
          "cf-connecting-ip": "192.0.2.250",
          "content-type": "application/json",
        },
        body: JSON.stringify(extensionBody),
      },
    ),
  );
  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toMatchObject({
    code: "authentication_required",
  });
});

test("every invalid capacity extension returns its explicit problem document", async () => {
  // A run that is not capacity-paused refuses extension outright.
  const collecting = await fixtureEvidenceRequest({
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "fixture-one-piece-json@1",
    idempotency_key: "capacity_extension_collecting_001",
    requests: [
      { id: "cards", url: "https://official-source.invalid/cards" },
    ],
  });
  expect(collecting.status).toBe(201);
  const collectingRun = await collecting.json<{ id: string }>();
  await clearActiveRunForNextScenario();

  const { runId } = await pauseRunAtCapacity("capacity_extension_problems_001");
  const problems: ReadonlyArray<
    readonly [string, Record<string, unknown>, number, string]
  > = [
    [
      collectingRun.id,
      {
        expected_request_capacity: 5_000,
        expected_capacity_generation: 1,
        request_capacity: 6_000,
        idempotency_key: "capacity_extension_not_paused_001",
      },
      409,
      "ingestion_run_not_paused",
    ],
    [
      "run_absent_000000000000",
      {
        expected_request_capacity: fusionWorldRequestCapacity,
        expected_capacity_generation: 1,
        request_capacity: 20_000,
        idempotency_key: "capacity_extension_absent_001",
      },
      404,
      "ingestion_evidence_not_found",
    ],
    [
      runId,
      {
        expected_request_capacity: fusionWorldRequestCapacity - 1,
        expected_capacity_generation: 1,
        request_capacity: 20_000,
        idempotency_key: "capacity_extension_stale_capacity_001",
      },
      409,
      "request_capacity_mismatch",
    ],
    [
      runId,
      {
        expected_request_capacity: fusionWorldRequestCapacity,
        expected_capacity_generation: 2,
        request_capacity: 20_000,
        idempotency_key: "capacity_extension_stale_generation_001",
      },
      409,
      "capacity_generation_mismatch",
    ],
    [
      runId,
      {
        expected_request_capacity: fusionWorldRequestCapacity,
        expected_capacity_generation: 1,
        request_capacity: fusionWorldRequestCapacity - 1,
        idempotency_key: "capacity_extension_decreased_001",
      },
      422,
      "request_capacity_decreased",
    ],
    [
      runId,
      {
        expected_request_capacity: fusionWorldRequestCapacity,
        expected_capacity_generation: 1,
        request_capacity: fusionWorldRequestCapacity,
        idempotency_key: "capacity_extension_unchanged_001",
      },
      422,
      "request_capacity_unchanged",
    ],
    [
      runId,
      {
        expected_request_capacity: fusionWorldRequestCapacity,
        expected_capacity_generation: 1,
        request_capacity: 25_000,
        idempotency_key: "capacity_extension_ceiling_001",
      },
      422,
      "request_capacity_exceeds_global_ceiling",
    ],
    [
      runId,
      {
        expected_request_capacity: fusionWorldRequestCapacity,
        expected_capacity_generation: 1,
        request_capacity: "20000",
        idempotency_key: "capacity_extension_malformed_001",
      },
      422,
      "request_capacity_invalid",
    ],
    [
      runId,
      {
        expected_request_capacity: fusionWorldRequestCapacity,
        expected_capacity_generation: 1,
        request_capacity: 20_000.5,
        idempotency_key: "capacity_extension_malformed_002",
      },
      422,
      "request_capacity_invalid",
    ],
    [
      runId,
      {
        expected_request_capacity: fusionWorldRequestCapacity,
        expected_capacity_generation: 0,
        request_capacity: 20_000,
        idempotency_key: "capacity_extension_malformed_003",
      },
      422,
      "capacity_generation_invalid",
    ],
  ];
  for (const [target, body, status, code] of problems) {
    const response = await administrationRequest(
      `/v1/ingestion-runs/${target}/capacity/extension`,
      "POST",
      body,
    );
    const problem = await response.json<{ code?: string }>();
    expect({ code: problem.code, status: response.status, body })
      .toEqual({ code, status, body });
  }

  // Reusing an idempotency key for a different extension conflicts instead
  // of replaying or extending.
  const first = await administrationRequest(
    `/v1/ingestion-runs/${runId}/capacity/extension`,
    "POST",
    {
      expected_request_capacity: fusionWorldRequestCapacity,
      expected_capacity_generation: 1,
      request_capacity: 16_000,
      idempotency_key: "capacity_extension_reused_001",
    },
  );
  expect(first.status).toBe(200);
  const reused = await administrationRequest(
    `/v1/ingestion-runs/${runId}/capacity/extension`,
    "POST",
    {
      expected_request_capacity: 16_000,
      expected_capacity_generation: 2,
      request_capacity: 17_000,
      idempotency_key: "capacity_extension_reused_001",
    },
  );
  expect(reused.status).toBe(409);
  await expect(reused.json()).resolves.toMatchObject({
    code: "idempotency_conflict",
  });

  // The stale expectations after a successful extension name the current
  // effective policy, and none of the refused operations extended anything.
  const stale = await administrationRequest(
    `/v1/ingestion-runs/${runId}/capacity/extension`,
    "POST",
    {
      expected_request_capacity: fusionWorldRequestCapacity,
      expected_capacity_generation: 1,
      request_capacity: 20_000,
      idempotency_key: "capacity_extension_stale_after_001",
    },
  );
  expect(stale.status).toBe(409);
  await expect(stale.json()).resolves.toMatchObject({
    code: "capacity_generation_mismatch",
  });
  expect(await env.CATALOGUE_DB.prepare(
    `SELECT COUNT(*) AS count FROM ingestion_run_capacity_extensions
     WHERE ingestion_run_id = ?`,
  ).bind(runId).first("count")).toBe(1);
}, 30_000);

test("concurrent capacity extensions admit exactly one generation advance", async () => {
  const { runId } = await pauseRunAtCapacity("capacity_extension_race_001");
  const responses = await Promise.all([1, 2].map((attempt) =>
    administrationRequest(
      `/v1/ingestion-runs/${runId}/capacity/extension`,
      "POST",
      {
        expected_request_capacity: fusionWorldRequestCapacity,
        expected_capacity_generation: 1,
        request_capacity: 18_000 + attempt,
        idempotency_key: `capacity_extension_race_writer_${attempt}`,
      },
    )
  ));
  const statuses = responses.map((response) => response.status).sort();
  expect(statuses).toEqual([200, 409]);
  const conflict = responses.find((response) => response.status === 409);
  await expect(conflict!.json()).resolves.toMatchObject({
    code: expect.stringMatching(
      /^(capacity_extension_conflict|capacity_generation_mismatch)$/,
    ),
  });
  const stored = await env.CATALOGUE_DB.prepare(
    `SELECT capacity_generation FROM ingestion_run_capacity_extensions
     WHERE ingestion_run_id = ?`,
  ).bind(runId).all();
  expect(stored.results).toHaveLength(1);
  expect(stored.results[0]).toMatchObject({ capacity_generation: 2 });
}, 30_000);
