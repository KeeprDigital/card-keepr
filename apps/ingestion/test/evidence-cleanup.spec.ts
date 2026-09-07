import { exports, env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { installRuntimeSuite } from "./runtime-helpers";

import { seedRunFixtureStatement } from "./query-helpers/run-events";

installRuntimeSuite();

async function request(path: string, now: string, body?: unknown) {
  const worker = (await import("../src/index")).default;
  // Control-plane simulation keeps race interleavings deterministic. A separate
  // test below runs the shipped Workflow without this boundary override.
  const workflow = new Proxy(env.RECONCILIATION_WORKFLOW, {
    get(target, property) {
      if (property === "create")
        return async (input: { id: string }) => ({ id: input.id, status: async () => ({ status: "queued" }) });
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return worker.fetch(
    new Request(`https://card-keepr.invalid${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: "Bearer vitest-administration-key",
        "content-type": "application/json",
        "x-keepr-test-now": now,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { ...env, RECONCILIATION_WORKFLOW: workflow },
  );
}

// Synthetic terminal fixture; no real-source or measured-capacity claim.
async function terminalRun(id: string) {
  await seedRunFixtureStatement(env.CATALOGUE_DB, {
    id,
    state: "failed",
    failure_code: "synthetic_capture_failure",
    started_at: "2026-08-01T00:00:00.000Z",
    terminal_at: "2026-08-01T00:00:00.000Z",
    idempotency_key: id,
  }).run();
}

test("owner cleanup persists the exact thirty-day eligibility boundary and resumes its intent", async () => {
  await terminalRun("cleanup_boundary");
  const path = "/v1/ingestion-runs/cleanup_boundary/evidence-cleanup";
  const early = await request(path, "2026-08-30T23:59:59.999Z", { idempotency_key: "cleanup_boundary" });
  expect(early.status).toBe(409);
  const due = await request(path, "2026-08-31T00:00:00.000Z", { idempotency_key: "cleanup_boundary" });
  expect(due.status).toBe(202);
  const intent = (await due.json()) as { id: string; retention_days: number; eligible_at: string; state: string };
  expect(intent).toMatchObject({ retention_days: 30, eligible_at: "2026-08-31T00:00:00.000Z", state: "pending" });
  const progress = await request(`/v1/evidence-cleanups/${intent.id}/advance`, "2026-08-31T00:00:01.000Z", {});
  expect(progress.status).toBe(200);
  expect(await progress.json()).toMatchObject({ id: intent.id, state: "completed", deleted_objects: 0 });
  const replay = await request(path, "2026-09-01T00:00:00.000Z", { idempotency_key: "cleanup_boundary" });
  expect(await replay.json()).toMatchObject({ id: intent.id, state: "completed" });
});

async function capturedObject(run: string, key = `source-snapshots/${run}.bin`) {
  await terminalRun(run);
  const registration = await env.CATALOGUE_DB.prepare(
    "SELECT * FROM source_adapter_versions WHERE source_lineage='one-piece-en'",
  ).first<{ adapter_version: string; game_profile_version: string; source_lineage: string; supported_game: string }>();
  if (!registration) throw new Error("missing registration");
  await env.CATALOGUE_DB.prepare(`INSERT INTO source_requests
    (ingestion_run_id,request_id,sequence_number,method,url,request_headers_json,representation_fingerprint,state)
    VALUES (?,'request',1,'GET','https://official-source.invalid/cards','{}','fixture','captured')`)
    .bind(run)
    .run();
  await env.CATALOGUE_DB.prepare(`INSERT INTO source_capture_operations
    (attempt_id,ingestion_run_id,request_id,attempt_number,source_snapshot_id,content_object_key,state,requested_at)
    VALUES (?,?,'request',1,?,?,'finalized','2026-08-01T00:00:00.000Z')`)
    .bind(run, run, run, key)
    .run();
  await env.CATALOGUE_DB.prepare(`INSERT INTO source_fetch_attempts
    (id,ingestion_run_id,request_id,attempt_number,requested_at,completed_at,outcome,response_headers_json)
    VALUES (?,?,'request',1,'2026-08-01T00:00:00.000Z','2026-08-01T00:00:00.000Z','success','{}')`)
    .bind(run, run)
    .run();
  await env.CATALOGUE_DB.prepare(`INSERT INTO source_snapshots
    (id,ingestion_run_id,request_id,fetch_attempt_id,request_method,request_url,request_headers_json,representation_fingerprint,response_vary_json,retrieved_at,http_status,response_headers_json,content_digest,content_byte_length,content_object_key,source_lineage,supported_game,game_profile_version,adapter_version)
    VALUES (?,?,'request',?,'GET','https://official-source.invalid/cards','{}','fixture','[]','2026-08-01T00:00:00.000Z',200,'{}',?,7,?,?,?,?,?)`)
    .bind(
      run,
      run,
      run,
      "a".repeat(64),
      key,
      registration.source_lineage,
      registration.supported_game,
      registration.game_profile_version,
      registration.adapter_version,
    )
    .run();
  await env.EVIDENCE_OBJECTS.put(key, "fixture");
  return key;
}

test("unused terminal capture bytes are deleted with retained results and content becomes explicitly gone", async () => {
  const key = await capturedObject("cleanup_unused");
  const response = await request("/v1/ingestion-runs/cleanup_unused/evidence-cleanup", "2026-08-31T00:00:00.000Z", {
    idempotency_key: "cleanup_unused",
  });
  expect(response.status).toBe(202);
  const intent = (await response.json()) as { id: string };
  const advance = await request(`/v1/evidence-cleanups/${intent.id}/advance`, "2026-08-31T00:00:01.000Z", {});
  expect(advance.status).toBe(200);
  expect(await advance.json()).toMatchObject({ state: "completed", deleted_objects: 1 });
  expect(await env.EVIDENCE_OBJECTS.head(key)).toBeNull();
  const content = await request("/v1/source-snapshots/cleanup_unused/content", "2026-08-31T00:00:02.000Z");
  expect(content.status).toBe(410);
});

test("references acquired after intent protect shared bytes before deletion", async () => {
  const key = await capturedObject("cleanup_acquired");
  const begin = await request("/v1/ingestion-runs/cleanup_acquired/evidence-cleanup", "2026-08-31T00:00:00.000Z", {
    idempotency_key: "cleanup_acquired",
  });
  const intent = (await begin.json()) as { id: string };
  await env.CATALOGUE_DB.prepare(
    `INSERT INTO evidence_object_references VALUES (?,'owner_decision','decision_after_intent','2026-08-31T00:00:00.500Z')`,
  )
    .bind(key)
    .run();
  const advance = await request(`/v1/evidence-cleanups/${intent.id}/advance`, "2026-08-31T00:00:01.000Z", {});
  expect(await advance.json()).toMatchObject({ state: "completed", deleted_objects: 0, protected_objects: 1 });
  expect((await env.EVIDENCE_OBJECTS.head(key))?.size).toBe(7);
});

test("cleanup cannot race a reference acquisition during the R2 delete and retries a lost delete response", async () => {
  const key = await capturedObject("cleanup_race");
  const begin = await request("/v1/ingestion-runs/cleanup_race/evidence-cleanup", "2026-08-31T00:00:00.000Z", {
    idempotency_key: "cleanup_race",
  });
  const intent = (await begin.json()) as { id: string };
  const worker = (await import("../src/index")).default;
  let deleted = false;
  const bucket = new Proxy(env.EVIDENCE_OBJECTS, {
    get(target, property) {
      if (property === "delete")
        return async (objectKey: string) => {
          expect(objectKey).toBe(key);
          await expect(
            env.CATALOGUE_DB.prepare(
              `INSERT INTO evidence_object_references VALUES (?,'candidate','concurrent','2026-08-31T00:00:01.000Z')`,
            )
              .bind(key)
              .run(),
          ).rejects.toThrow("evidence_cleanup_reference_fenced");
          await target.delete(objectKey);
          deleted = true;
          throw new Error("synthetic lost R2 response after successful delete");
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const response = await worker.fetch(
    new Request(`https://card-keepr.invalid/v1/evidence-cleanups/${intent.id}/advance`, {
      method: "POST",
      headers: {
        authorization: "Bearer vitest-administration-key",
        "content-type": "application/json",
        "x-keepr-test-now": "2026-08-31T00:00:01.000Z",
      },
      body: "{}",
    }),
    { ...env, EVIDENCE_OBJECTS: bucket },
  );
  expect(deleted).toBe(true);
  expect(await response.json()).toMatchObject({
    state: "paused",
    deleted_objects: 0,
    failure_code: "evidence_cleanup_storage_retry_required",
  });
  const retry = await request(`/v1/evidence-cleanups/${intent.id}/advance`, "2026-08-31T00:00:02.000Z", {});
  expect(await retry.json()).toMatchObject({ state: "completed", deleted_objects: 1 });
  expect(await env.EVIDENCE_OBJECTS.head(key)).toBeNull();
});

async function verifiedBackup(id: string, started: string, completed: string) {
  await env.CATALOGUE_DB.prepare(`INSERT INTO catalogue_backup_attempts
    (idempotency_key,request_json,owner_token,catalogue_revision_id,state,object_key,d1_bookmark,started_at,completed_at,manifest_key,content_sha256,manifest_sha256,export_bytes,schema_migration_level,disposable_database_id,restore_generation,restore_phase)
    VALUES (?,'{}',?,'catrev_spine_000','verified',?,'bookmark',?,?,? ,?,?,1,24,'fixture-disposable',1,'verified')`)
    .bind(id, id, `backups/${id}`, started, completed, `backups/${id}.json`, "a".repeat(64), "b".repeat(64))
    .run();
  await env.CATALOGUE_DB.prepare(
    `INSERT INTO catalogue_backup_retention VALUES (?,1,NULL,'newest-indefinite-and-dated-90-days')`,
  )
    .bind(id)
    .run();
}

test("logical reclamation waits for retained pre-reservation backups, then reclaims after ordinary retention rotation", async () => {
  const key = await capturedObject("cleanup_backup");
  await verifiedBackup("cleanup_old_backup", "2026-08-10T00:00:00.000Z", "2026-08-10T01:00:00.000Z");
  const begin = await request("/v1/ingestion-runs/cleanup_backup/evidence-cleanup", "2026-08-31T00:00:00.000Z", {
    idempotency_key: "cleanup_backup",
  });
  const intent = (await begin.json()) as { id: string };
  const wait = await request(`/v1/evidence-cleanups/${intent.id}/advance`, "2026-08-31T00:00:01.000Z", {});
  expect(await wait.json()).toMatchObject({
    state: "paused",
    failure_code: "evidence_cleanup_waiting_backup_retention",
    deleted_objects: 0,
  });
  expect((await env.EVIDENCE_OBJECTS.head(key))?.size).toBe(7);
  expect((await request("/v1/source-snapshots/cleanup_backup/content", "2026-08-31T00:00:02.000Z")).status).toBe(410);
  // Simulated verified post-reservation checkpoint and ordinary 90-day retention;
  // no production backup is changed or deleted by cleanup.
  await env.CATALOGUE_DB.prepare(
    `UPDATE catalogue_backup_retention SET newest_success=0,retain_until='2026-11-08T01:00:00.000Z' WHERE attempt_id='cleanup_old_backup'`,
  ).run();
  await verifiedBackup("cleanup_new_backup", "2026-09-01T00:00:00.000Z", "2026-09-01T01:00:00.000Z");
  const boundary = await request(`/v1/evidence-cleanups/${intent.id}/advance`, "2026-11-08T01:00:00.000Z", {});
  expect(await boundary.json()).toMatchObject({ deleted_objects: 0, state: "paused" });
  const ready = await request(`/v1/evidence-cleanups/${intent.id}/advance`, "2026-11-08T01:00:00.001Z", {});
  expect(await ready.json()).toMatchObject({ state: "completed", deleted_objects: 1 });
  expect(await env.EVIDENCE_OBJECTS.head(key)).toBeNull();
});

test("automatic shipped cleanup Workflow completes without a CLI advance loop", async () => {
  const key = await capturedObject("cleanup_workflow");
  const begin = await exports.default.fetch(
    new Request("https://card-keepr.invalid/v1/ingestion-runs/cleanup_workflow/evidence-cleanup", {
      method: "POST",
      headers: {
        authorization: "Bearer vitest-administration-key",
        "content-type": "application/json",
        "x-keepr-test-now": "2026-08-31T00:00:00.000Z",
      },
      body: JSON.stringify({ idempotency_key: "cleanup_workflow" }),
    }),
  );
  expect(begin.status).toBe(202);
  const intent = (await begin.json()) as { id: string };
  let status: { state: string; deleted_objects: number } | undefined;
  for (let n = 0; n < 100; n++) {
    const response = await request(`/v1/evidence-cleanups/${intent.id}`, "2026-09-08T00:00:00.000Z");
    status = (await response.json()) as typeof status;
    if (status?.state === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(status).toMatchObject({ state: "completed", deleted_objects: 1 });
  expect(await env.EVIDENCE_OBJECTS.head(key)).toBeNull();
});

test("an unsettled multipart writer is conclusively aborted and cannot complete after cleanup", async () => {
  const key = await capturedObject("cleanup_multipart");
  const upload = await env.EVIDENCE_OBJECTS.createMultipartUpload(key);
  const part = await upload.uploadPart(1, new Uint8Array([1, 2, 3]));
  await env.CATALOGUE_DB.prepare(
    `INSERT INTO evidence_object_writers(token,ingestion_run_id,object_key,started_at,multipart_upload_id) VALUES ('multipart-writer','cleanup_multipart',?,'2026-08-01T00:00:00.000Z',?)`,
  )
    .bind(key, upload.uploadId)
    .run();
  const begin = await request("/v1/ingestion-runs/cleanup_multipart/evidence-cleanup", "2026-08-31T00:00:00.000Z", {
    idempotency_key: "cleanup_multipart",
  });
  const intent = (await begin.json()) as { id: string };
  const advance = await request(`/v1/evidence-cleanups/${intent.id}/advance`, "2026-08-31T00:00:01.000Z", {});
  expect(await advance.json()).toMatchObject({ state: "completed", deleted_objects: 1 });
  await expect(upload.complete([part])).rejects.toThrow();
  expect(await env.EVIDENCE_OBJECTS.head(key)).toBeNull();
});

test("newly acquired paused shared snapshot preserves its physical bytes", async () => {
  const key = await capturedObject("cleanup_shared");
  const begin = await request("/v1/ingestion-runs/cleanup_shared/evidence-cleanup", "2026-08-31T00:00:00.000Z", {
    idempotency_key: "cleanup_shared",
  });
  const intent = (await begin.json()) as { id: string };
  await seedRunFixtureStatement(env.CATALOGUE_DB, { id: "cleanup_new_reference", state: "paused" }).run();
  // A native revalidation retains a new snapshot identity pointing at the same
  // physical content, acquired after cleanup's owner intent.
  await env.CATALOGUE_DB.prepare(`INSERT INTO source_fetch_attempts(id,ingestion_run_id,request_id,attempt_number,requested_at,completed_at,outcome,response_headers_json)
    SELECT 'shared-fetch',ingestion_run_id,request_id,2,requested_at,completed_at,'cache_revalidated',response_headers_json FROM source_fetch_attempts WHERE id='cleanup_shared'`).run();
  await env.CATALOGUE_DB.prepare(
    `INSERT INTO source_snapshots SELECT 'shared-snapshot','cleanup_new_reference',request_id,'shared-fetch',request_method,request_url,request_headers_json,representation_fingerprint,response_vary_json,retrieved_at,http_status,response_headers_json,media_type,content_digest,content_byte_length,content_object_key,source_lineage,supported_game,game_profile_version,adapter_version,id FROM source_snapshots WHERE id='cleanup_shared'`,
  ).run();
  const advance = await request(`/v1/evidence-cleanups/${intent.id}/advance`, "2026-08-31T00:00:01.000Z", {});
  expect(await advance.json()).toMatchObject({ state: "completed", protected_objects: 1, deleted_objects: 0 });
  expect((await env.EVIDENCE_OBJECTS.head(key))?.size).toBe(7);
});

async function abandonedStaging(preparation: string, key: string, extraKey?: string) {
  await terminalRun(preparation);
  await env.CATALOGUE_DB.prepare(`INSERT INTO reconciliation_operations
    (id,ingestion_run_id,state,created_at,deadline,definition_pins_json,observation_cutoff,identity_decision_cutoff,authority_decision_cutoff,terminal_at)
    VALUES (?,?,'preparing','2026-08-01T00:00:00.000Z','2026-08-08T00:00:00.000Z','{}',0,0,0,NULL)`)
    .bind(preparation, preparation)
    .run();
  await env.CATALOGUE_DB.prepare(`INSERT INTO staging_objects(binding,object_key) VALUES ('CATALOGUE_EXPORTS',?)`)
    .bind(key)
    .run();
  // Synthetic lost-worker fixture: the write returned, but no retained artifact
  // or Merkle-node receipt was committed before abandonment.
  await env.CATALOGUE_DB.prepare(`UPDATE reconciliation_operations SET state='preparing' WHERE id=?`)
    .bind(preparation)
    .run();
  await env.CATALOGUE_DB.prepare(
    `INSERT INTO staging_object_writes VALUES (?,?,'CATALOGUE_EXPORTS',?,0,'2026-08-01T00:00:00.000Z','2026-08-01T00:00:01.000Z')`,
  )
    .bind(preparation, preparation, key)
    .run();
  if (extraKey) {
    const { catalogueStore, trackedStagingBucket } = await import("../../../src/catalogue/shared");
    await trackedStagingBucket(
      catalogueStore(env.CATALOGUE_DB),
      env.CATALOGUE_EXPORTS,
      "CATALOGUE_EXPORTS",
      preparation,
    ).put(extraKey, "orphan");
  }
  await env.CATALOGUE_DB.prepare(`UPDATE reconciliation_operations SET state='abandoned' WHERE id=?`)
    .bind(preparation)
    .run();
  await env.CATALOGUE_EXPORTS.put(key, "orphan");
}

test("owner reclaims a positively inventoried abandoned preparation orphan without traversing shared roots", async () => {
  await abandonedStaging("staging_orphan", "publication-artifacts/orphan");
  const response = await request(
    "/v1/reconciliation-operations/staging_orphan/evidence-cleanup",
    "2026-10-09T00:00:00.000Z",
    { idempotency_key: "staging_orphan" },
  );
  expect(response.status).toBe(202);
  const intent = (await response.json()) as { id: string };
  const advance = await request(`/v1/evidence-cleanups/${intent.id}/advance`, "2026-10-09T00:00:01.000Z", {});
  expect(await advance.json()).toMatchObject({ state: "completed", deleted_objects: 1, scope: "staging" });
  expect(await env.CATALOGUE_EXPORTS.head("publication-artifacts/orphan")).toBeNull();
});

async function activeStaging(preparation: string) {
  await terminalRun(preparation);
  await env.CATALOGUE_DB.prepare(`INSERT INTO reconciliation_operations
    (id,ingestion_run_id,state,created_at,deadline,definition_pins_json,observation_cutoff,identity_decision_cutoff,authority_decision_cutoff)
    VALUES (?,?,'preparing','2026-09-08T00:00:00.000Z','2026-09-15T00:00:00.000Z','{}',0,0,0)`)
    .bind(preparation, preparation)
    .run();
}

test("a conclusively deleted staging key can hold the same bytes for a new preparation; old delete tickets cannot cross incarnations", async () => {
  const key = "publication-artifacts/reused";
  await abandonedStaging("staging_old", key);
  const begin = await request(
    "/v1/reconciliation-operations/staging_old/evidence-cleanup",
    "2026-10-09T00:00:00.000Z",
    { idempotency_key: "staging_old" },
  );
  const intent = (await begin.json()) as { id: string };
  expect((await request(`/v1/evidence-cleanups/${intent.id}/advance`, "2026-10-09T00:00:01.000Z", {})).status).toBe(
    200,
  );
  await activeStaging("staging_fresh");
  const { catalogueStore, trackedStagingBucket } = await import("../../../src/catalogue/shared");
  await trackedStagingBucket(
    catalogueStore(env.CATALOGUE_DB),
    env.CATALOGUE_EXPORTS,
    "CATALOGUE_EXPORTS",
    "staging_fresh",
  ).put(key, "orphan");
  expect(
    await env.CATALOGUE_DB.prepare(`SELECT incarnation,state FROM staging_objects WHERE object_key=?`)
      .bind(key)
      .first(),
  ).toMatchObject({ incarnation: 1, state: "available" });
  await expect(
    env.CATALOGUE_DB.prepare(
      `INSERT INTO staging_object_deletes VALUES ('stale-deleter','CATALOGUE_EXPORTS',?,0,?,'2026-10-09T00:00:02.000Z',NULL)`,
    )
      .bind(key, intent.id)
      .run(),
  ).rejects.toThrow("staging_deleter_fenced");
  await request(`/v1/evidence-cleanups/${intent.id}/advance`, "2026-10-09T00:00:03.000Z", {});
  expect(await (await env.CATALOGUE_EXPORTS.get(key))?.text()).toBe("orphan");
});

test("an ambiguous staging deletion keeps its ticket open and prevents reuse despite another HEAD showing absence", async () => {
  const key = "publication-artifacts/ambiguous";
  await abandonedStaging("staging_unknown", key);
  const begin = await request(
    "/v1/reconciliation-operations/staging_unknown/evidence-cleanup",
    "2026-10-09T00:00:00.000Z",
    { idempotency_key: "staging_unknown" },
  );
  const intent = (await begin.json()) as { id: string };
  const worker = (await import("../src/index")).default;
  const bucket = new Proxy(env.CATALOGUE_EXPORTS, {
    get(target, property) {
      if (property === "delete")
        return async (key: string) => {
          await target.delete(key);
          throw new Error("synthetic ambiguous delete response");
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const response = await worker.fetch(
    new Request(`https://card-keepr.invalid/v1/evidence-cleanups/${intent.id}/advance`, {
      method: "POST",
      headers: {
        authorization: "Bearer vitest-administration-key",
        "content-type": "application/json",
        "x-keepr-test-now": "2026-10-09T00:00:01.000Z",
      },
      body: "{}",
    }),
    { ...env, CATALOGUE_EXPORTS: bucket },
  );
  expect(await response.json()).toMatchObject({ state: "paused", deleted_objects: 0 });
  expect(await env.CATALOGUE_EXPORTS.head(key)).toBeNull();
  await activeStaging("staging_new_after_unknown");
  const { catalogueStore, trackedStagingBucket } = await import("../../../src/catalogue/shared");
  await expect(
    trackedStagingBucket(
      catalogueStore(env.CATALOGUE_DB),
      env.CATALOGUE_EXPORTS,
      "CATALOGUE_EXPORTS",
      "staging_new_after_unknown",
    ).put(key, "orphan"),
  ).rejects.toThrow("staging_writer_fenced");
  const retry = await request(`/v1/evidence-cleanups/${intent.id}/advance`, "2027-10-09T00:00:00.000Z", {});
  expect(await retry.json()).toMatchObject({ state: "paused", deleted_objects: 0 });
});

test("a live uploaded 304 reference protects bytes before its new snapshot is finalized", async () => {
  const key = await capturedObject("cleanup_revalidation");
  await seedRunFixtureStatement(env.CATALOGUE_DB, { id: "live_revalidation", state: "paused" }).run();
  await env.CATALOGUE_DB.prepare(
    `INSERT INTO source_requests(ingestion_run_id,request_id,sequence_number,method,url,request_headers_json,representation_fingerprint,state) VALUES ('live_revalidation','request',1,'GET','https://source.invalid/304','{}','fixture','pending')`,
  ).run();
  await env.CATALOGUE_DB.prepare(
    `INSERT INTO source_capture_operations(attempt_id,ingestion_run_id,request_id,attempt_number,source_snapshot_id,content_object_key,state,requested_at,reused_source_snapshot_id) VALUES ('live304','live_revalidation','request',1,'live304','source-snapshots/live304.bin','uploaded','2026-08-31T00:00:00.000Z','cleanup_revalidation')`,
  ).run();
  const begin = await request("/v1/ingestion-runs/cleanup_revalidation/evidence-cleanup", "2026-08-31T00:00:00.000Z", {
    idempotency_key: "cleanup_revalidation",
  });
  expect(begin.status).toBe(202);
  const intent = (await begin.json()) as { id: string };
  const progress = await request(`/v1/evidence-cleanups/${intent.id}/advance`, "2026-08-31T00:00:01.000Z", {});
  expect(await progress.json()).toMatchObject({ state: "completed", protected_objects: 1, deleted_objects: 0 });
  expect(await env.EVIDENCE_OBJECTS.head(key)).not.toBeNull();
});

test("a corrupted terminal projection cannot authorize a cleanup or physical delete", async () => {
  const key = await capturedObject("cleanup_corrupt");
  const begin = await request("/v1/ingestion-runs/cleanup_corrupt/evidence-cleanup", "2026-08-31T00:00:00.000Z", {
    idempotency_key: "cleanup_corrupt",
  });
  expect(begin.status).toBe(202);
  const intent = (await begin.json()) as { id: string };
  await env.CATALOGUE_DB.prepare(
    `UPDATE ingestion_run_current SET terminal_at='2026-07-01T00:00:00.000Z' WHERE ingestion_run_id='cleanup_corrupt'`,
  ).run();
  const rejected = await request("/v1/ingestion-runs/cleanup_corrupt/evidence-cleanup", "2026-08-31T00:00:00.000Z", {
    idempotency_key: "cleanup_corrupt_2",
  });
  expect(rejected.status).toBeGreaterThanOrEqual(400);
  const progress = await request(`/v1/evidence-cleanups/${intent.id}/advance`, "2026-08-31T00:00:01.000Z", {});
  expect(progress.status).toBeGreaterThanOrEqual(400);
  expect(await env.EVIDENCE_OBJECTS.head(key)).not.toBeNull();
});

test("exhausted Workflow retries retain a pause that an explicit retry resumes", async () => {
  await terminalRun("cleanup_exhausted");
  const begin = await request("/v1/ingestion-runs/cleanup_exhausted/evidence-cleanup", "2026-08-31T00:00:00.000Z", {
    idempotency_key: "cleanup_exhausted",
  });
  const intent = (await begin.json()) as { id: string };
  const { runEvidenceCleanupWorkflow } = await import("../src/evidence-cleanup-workflow");
  // Workflow boundary simulates an exhausted step, then lets the failure receipt
  // commit through real D1. No storage or cleanup state is simulated.
  const step = {
    do: async (name: string, ...args: unknown[]) => {
      if (name === "cleanup unit 0") throw new Error("exhausted injected transport failure");
      return (args.at(-1) as () => Promise<unknown>)();
    },
  };
  await runEvidenceCleanupWorkflow(env, step as unknown as import("cloudflare:workers").WorkflowStep, {
    id: intent.id,
    generation: 0,
    shard: 0,
  });
  const paused = await request(`/v1/evidence-cleanups/${intent.id}`, "2026-08-31T00:00:01.000Z");
  expect(await paused.json()).toMatchObject({
    state: "paused",
    failure_code: "evidence_cleanup_workflow_retry_required",
    generation: 0,
  });
  const retry = await request(`/v1/evidence-cleanups/${intent.id}/retry`, "2026-08-31T00:00:01.000Z", {
    expected_generation: 0,
  });
  expect(await retry.json()).toMatchObject({ state: "pending", generation: 1 });
  await runEvidenceCleanupWorkflow(env, step as unknown as import("cloudflare:workers").WorkflowStep, {
    id: intent.id,
    generation: 0,
    shard: 0,
  });
  const fresh = await request(`/v1/evidence-cleanups/${intent.id}`, "2026-08-31T00:00:01.000Z");
  expect(await fresh.json()).toMatchObject({ state: "pending", generation: 1 });
});

test("an unrelated staging key progresses while a prior delete outcome remains unknown", async () => {
  const blocked = "publication-artifacts/a-unknown",
    free = "publication-artifacts/z-free";
  await abandonedStaging("staging_independent", blocked, free);
  const begin = await request(
    "/v1/reconciliation-operations/staging_independent/evidence-cleanup",
    "2026-10-09T00:00:00.000Z",
    { idempotency_key: "staging_independent" },
  );
  const intent = (await begin.json()) as { id: string };
  const { advanceStagingCleanup } = await import("../../../src/catalogue/source-evidence");
  const { catalogueStore } = await import("../../../src/catalogue/shared");
  const bucket = new Proxy(env.CATALOGUE_EXPORTS, {
    get(target, property) {
      if (property === "delete")
        return async (key: string) => {
          if (key === blocked) throw new Error("unknown transport outcome");
          return target.delete(key);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const progress = await advanceStagingCleanup(
    catalogueStore(env.CATALOGUE_DB),
    { PRINTING_IMAGES: env.PRINTING_IMAGES, CATALOGUE_EXPORTS: bucket },
    intent.id,
    "2026-10-09T00:00:01.000Z",
  );
  expect(progress).toMatchObject({ state: "paused", deleted_objects: 1 });
  expect(await env.CATALOGUE_EXPORTS.head(free)).toBeNull();
  expect(await env.CATALOGUE_EXPORTS.head(blocked)).not.toBeNull();
});
