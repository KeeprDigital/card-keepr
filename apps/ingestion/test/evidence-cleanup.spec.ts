import { exports, env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { catalogueStore } from "../../../src/catalogue/shared";
import { stagingPreparation } from "../../../src/catalogue/source-evidence/staging-cleanup-repository";
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
  expect(await early.json()).toMatchObject({ code: "evidence_cleanup_not_eligible" });
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
  await env.CATALOGUE_DB.prepare(
    `INSERT INTO source_requests
    (ingestion_run_id,request_id,sequence_number,method,url,request_headers_json,representation_fingerprint,state)
    VALUES (?,'request',1,'GET','https://official-source.invalid/cards','{}','fixture','captured')`,
  )
    .bind(run)
    .run();
  await env.CATALOGUE_DB.prepare(
    `INSERT INTO source_capture_operations
    (attempt_id,ingestion_run_id,request_id,attempt_number,source_snapshot_id,content_object_key,state,requested_at)
    VALUES (?,?,'request',1,?,?,'finalized','2026-08-01T00:00:00.000Z')`,
  )
    .bind(run, run, run, key)
    .run();
  await env.CATALOGUE_DB.prepare(
    `INSERT INTO source_fetch_attempts
    (id,ingestion_run_id,request_id,attempt_number,requested_at,completed_at,outcome,response_headers_json)
    VALUES (?,?,'request',1,'2026-08-01T00:00:00.000Z','2026-08-01T00:00:00.000Z','success','{}')`,
  )
    .bind(run, run)
    .run();
  await env.CATALOGUE_DB.prepare(
    `INSERT INTO source_snapshots
    (id,ingestion_run_id,request_id,fetch_attempt_id,request_method,request_url,request_headers_json,representation_fingerprint,response_vary_json,retrieved_at,http_status,response_headers_json,content_digest,content_byte_length,content_object_key,source_lineage,supported_game,game_profile_version,adapter_version)
    VALUES (?,?,'request',?,'GET','https://official-source.invalid/cards','{}','fixture','[]','2026-08-01T00:00:00.000Z',200,'{}',?,7,?,?,?,?,?)`,
  )
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
  await env.CATALOGUE_DB.prepare(
    `INSERT INTO catalogue_backup_attempts
    (idempotency_key,request_json,owner_token,catalogue_revision_id,state,object_key,d1_bookmark,started_at,completed_at,manifest_key,content_sha256,manifest_sha256,export_bytes,schema_migration_level,disposable_database_id,restore_generation,restore_phase)
    VALUES (?,'{}',?,'catrev_spine_000','verified',?,'bookmark',?,?,? ,?,?,1,24,'fixture-disposable',1,'verified')`,
  )
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
  await env.CATALOGUE_DB.prepare(
    `INSERT INTO source_fetch_attempts(id,ingestion_run_id,request_id,attempt_number,requested_at,completed_at,outcome,response_headers_json)
    SELECT 'shared-fetch',ingestion_run_id,request_id,2,requested_at,completed_at,'cache_revalidated',response_headers_json FROM source_fetch_attempts WHERE id='cleanup_shared'`,
  ).run();
  await env.CATALOGUE_DB.prepare(
    `INSERT INTO source_snapshots SELECT 'shared-snapshot','cleanup_new_reference',request_id,'shared-fetch',request_method,request_url,request_headers_json,representation_fingerprint,response_vary_json,retrieved_at,http_status,response_headers_json,media_type,content_digest,content_byte_length,content_object_key,source_lineage,supported_game,game_profile_version,adapter_version,id FROM source_snapshots WHERE id='cleanup_shared'`,
  ).run();
  const advance = await request(`/v1/evidence-cleanups/${intent.id}/advance`, "2026-08-31T00:00:01.000Z", {});
  expect(await advance.json()).toMatchObject({ state: "completed", protected_objects: 1, deleted_objects: 0 });
  expect((await env.EVIDENCE_OBJECTS.head(key))?.size).toBe(7);
});

async function abandonedStaging(preparation: string, key: string, extraKey?: string) {
  await terminalRun(preparation);
  await env.CATALOGUE_DB.prepare(
    `INSERT INTO reconciliation_operations
    (id,ingestion_run_id,state,created_at,deadline,definition_pins_json,observation_cutoff,identity_decision_cutoff,authority_decision_cutoff,terminal_at)
    VALUES (?,?,'preparing','2026-08-01T00:00:00.000Z','2026-08-08T00:00:00.000Z','{}',0,0,0,NULL)`,
  )
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

// The database records abandonment using its own clock. Base eligibility on
// that retained timestamp so this fixture cannot expire as calendar time passes.
async function stagingCleanupAt(preparation: string, seconds = 0): Promise<string> {
  const terminalAt = await stagingPreparation(catalogueStore(env.CATALOGUE_DB), preparation).first<string>(
    "terminal_at",
  );
  if (terminalAt === null) throw new Error("The staging fixture has no terminal timestamp.");
  return new Date(Date.parse(terminalAt) + 30 * 86_400_000 + seconds * 1000).toISOString();
}

test("owner reclaims a positively inventoried abandoned preparation orphan without traversing shared roots", async () => {
  await abandonedStaging("staging_orphan", "publication-artifacts/orphan");
  const early = await request(
    "/v1/reconciliation-operations/staging_orphan/evidence-cleanup",
    await stagingCleanupAt("staging_orphan", -0.001),
    { idempotency_key: "staging_orphan" },
  );
  expect(early.status).toBe(409);
  const response = await request(
    "/v1/reconciliation-operations/staging_orphan/evidence-cleanup",
    await stagingCleanupAt("staging_orphan", 0),
    { idempotency_key: "staging_orphan" },
  );
  expect(response.status).toBe(202);
  const intent = (await response.json()) as { id: string };
  const advance = await request(
    `/v1/evidence-cleanups/${intent.id}/advance`,
    await stagingCleanupAt("staging_orphan", 1),
    {},
  );
  expect(await advance.json()).toMatchObject({ state: "completed", deleted_objects: 1, scope: "staging" });
  expect(await env.CATALOGUE_EXPORTS.head("publication-artifacts/orphan")).toBeNull();
});

async function activeStaging(preparation: string) {
  await terminalRun(preparation);
  await env.CATALOGUE_DB.prepare(
    `INSERT INTO reconciliation_operations
    (id,ingestion_run_id,state,created_at,deadline,definition_pins_json,observation_cutoff,identity_decision_cutoff,authority_decision_cutoff)
    VALUES (?,?,'preparing','2026-09-08T00:00:00.000Z','2026-09-15T00:00:00.000Z','{}',0,0,0)`,
  )
    .bind(preparation, preparation)
    .run();
}

test("a conclusively deleted staging key can hold the same bytes for a new preparation; old delete tickets cannot cross incarnations", async () => {
  const key = "publication-artifacts/reused";
  await abandonedStaging("staging_old", key);
  const begin = await request(
    "/v1/reconciliation-operations/staging_old/evidence-cleanup",
    await stagingCleanupAt("staging_old", 0),
    { idempotency_key: "staging_old" },
  );
  const intent = (await begin.json()) as { id: string };
  expect(
    (await request(`/v1/evidence-cleanups/${intent.id}/advance`, await stagingCleanupAt("staging_old", 1), {})).status,
  ).toBe(200);
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
      `INSERT INTO staging_object_deletes VALUES ('stale-deleter','CATALOGUE_EXPORTS',?,0,?,?,NULL)`,
    )
      .bind(key, intent.id, await stagingCleanupAt("staging_old", 2))
      .run(),
  ).rejects.toThrow("staging_deleter_fenced");
  await request(`/v1/evidence-cleanups/${intent.id}/advance`, await stagingCleanupAt("staging_old", 3), {});
  expect(await (await env.CATALOGUE_EXPORTS.get(key))?.text()).toBe("orphan");
});

test("an ambiguous staging deletion keeps its ticket open and prevents reuse despite another HEAD showing absence", async () => {
  const key = "publication-artifacts/ambiguous";
  await abandonedStaging("staging_unknown", key);
  const begin = await request(
    "/v1/reconciliation-operations/staging_unknown/evidence-cleanup",
    await stagingCleanupAt("staging_unknown", 0),
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
        "x-keepr-test-now": await stagingCleanupAt("staging_unknown", 1),
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

test.each([false, true])(
  "a live uploaded 304 reference protects bytes before finalization (corrupt projection: %s)",
  async (corrupt) => {
    const key = await capturedObject("cleanup_revalidation");
    await seedRunFixtureStatement(env.CATALOGUE_DB, { id: "live_revalidation", state: "paused" }).run();
    await env.CATALOGUE_DB.prepare(
      `INSERT INTO source_requests(ingestion_run_id,request_id,sequence_number,method,url,request_headers_json,representation_fingerprint,state) VALUES ('live_revalidation','request',1,'GET','https://source.invalid/304','{}','fixture','pending')`,
    ).run();
    await env.CATALOGUE_DB.prepare(
      `INSERT INTO source_capture_operations(attempt_id,ingestion_run_id,request_id,attempt_number,source_snapshot_id,content_object_key,state,requested_at,reused_source_snapshot_id) VALUES ('live304','live_revalidation','request',1,'live304','source-snapshots/live304.bin','uploaded','2026-08-31T00:00:00.000Z','cleanup_revalidation')`,
    ).run();
    const begin = await request(
      "/v1/ingestion-runs/cleanup_revalidation/evidence-cleanup",
      "2026-08-31T00:00:00.000Z",
      {
        idempotency_key: "cleanup_revalidation",
      },
    );
    expect(begin.status).toBe(202);
    const intent = (await begin.json()) as { id: string };
    if (corrupt)
      await env.CATALOGUE_DB.prepare(
        "UPDATE ingestion_run_current SET state='failed' WHERE ingestion_run_id='live_revalidation'",
      ).run();
    const progress = await request(`/v1/evidence-cleanups/${intent.id}/advance`, "2026-08-31T00:00:01.000Z", {});
    if (corrupt) expect(progress.status).toBeGreaterThanOrEqual(400);
    else expect(await progress.json()).toMatchObject({ state: "completed", protected_objects: 1, deleted_objects: 0 });
    expect(await env.EVIDENCE_OBJECTS.head(key)).not.toBeNull();
  },
);

test("an unfinished 304 reuse retains raw bytes until the newer failed owner's exact retention boundary", async () => {
  const key = await capturedObject("cleanup_old_304");
  await seedRunFixtureStatement(env.CATALOGUE_DB, {
    id: "recent_failed_304",
    state: "failed",
    failure_code: "synthetic_capture_failure",
    started_at: "2026-08-20T00:00:00.000Z",
    terminal_at: "2026-08-20T00:00:00.000Z",
  }).run();
  await env.CATALOGUE_DB.prepare(
    `INSERT INTO source_requests(ingestion_run_id,request_id,sequence_number,method,url,request_headers_json,representation_fingerprint,state) VALUES ('recent_failed_304','request',1,'GET','https://source.invalid/304','{}','fixture','pending')`,
  ).run();
  await env.CATALOGUE_DB.prepare(
    `INSERT INTO source_capture_operations(attempt_id,ingestion_run_id,request_id,attempt_number,source_snapshot_id,content_object_key,state,requested_at,reused_source_snapshot_id) VALUES ('recent304','recent_failed_304','request',1,'recent304','source-snapshots/recent304.bin','uploaded','2026-08-20T00:00:00.000Z','cleanup_old_304')`,
  ).run();
  for (const [now, protectedObjects, deletedObjects] of [
    ["2026-09-18T23:59:59.999Z", 1, 0],
    ["2026-09-19T00:00:00.000Z", 0, 1],
  ] as const) {
    const begin = await request("/v1/ingestion-runs/cleanup_old_304/evidence-cleanup", now, {
      idempotency_key: `cleanup_old_304_${deletedObjects}`,
    });
    expect(begin.status).toBe(202);
    const intent = (await begin.json()) as { id: string };
    const progress = await request(`/v1/evidence-cleanups/${intent.id}/advance`, now, {});
    expect(await progress.json()).toMatchObject({
      state: "completed",
      protected_objects: protectedObjects,
      deleted_objects: deletedObjects,
    });
    expect((await env.EVIDENCE_OBJECTS.head(key)) === null).toBe(deletedObjects === 1);
  }
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
    await stagingCleanupAt("staging_independent", 0),
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
    await stagingCleanupAt("staging_independent", 1),
  );
  expect(progress).toMatchObject({ state: "paused", deleted_objects: 1 });
  expect(await env.CATALOGUE_EXPORTS.head(free)).toBeNull();
  expect(await env.CATALOGUE_EXPORTS.head(blocked)).not.toBeNull();
});

test("historical published candidate evidence remains retained without any parsed observations", async () => {
  const key = await capturedObject("cleanup_historical");
  await env.CATALOGUE_DB.batch([
    env.CATALOGUE_DB.prepare(
      `INSERT INTO reconciliation_operations(id,ingestion_run_id,state,created_at,deadline,definition_pins_json,observation_cutoff,identity_decision_cutoff,authority_decision_cutoff) VALUES ('historical-preparation','cleanup_historical','failed','2026-08-01T00:00:00.000Z','2026-08-08T00:00:00.000Z','{}',0,0,0)`,
    ),
    env.CATALOGUE_DB.prepare(
      `INSERT INTO game_candidates(id,preparation_id,ingestion_run_id,supported_game,expected_game_revision_id,created_at,deadline,state,generation) VALUES ('historical-candidate','historical-preparation','cleanup_historical','one-piece','catrev_spine_000','2026-08-01T00:00:00.000Z','2026-08-08T00:00:00.000Z','published',0)`,
    ),
  ]);
  const begin = await request("/v1/ingestion-runs/cleanup_historical/evidence-cleanup", "2026-08-31T00:00:00.000Z", {
    idempotency_key: "cleanup_historical",
  });
  expect(begin.status).toBe(202);
  const intent = (await begin.json()) as { id: string };
  const progress = await request(`/v1/evidence-cleanups/${intent.id}/advance`, "2026-08-31T00:00:01.000Z", {});
  expect(await progress.json()).toMatchObject({ state: "completed", protected_objects: 1, deleted_objects: 0 });
  const content = await request("/v1/source-snapshots/cleanup_historical/content", "2026-08-31T00:00:01.000Z");
  expect(content.status).toBe(200);
  expect(await content.text()).toBe("fixture");
  expect(await env.EVIDENCE_OBJECTS.head(key)).not.toBeNull();
});

test("an explicit retention policy is durable and its changed replay is rejected", async () => {
  await terminalRun("cleanup_policy");
  const path = "/v1/ingestion-runs/cleanup_policy/evidence-cleanup";
  const early = await request(path, "2026-08-01T23:59:59.999Z", {
    idempotency_key: "cleanup_policy",
    retention_days: 1,
  });
  expect(early.status).toBe(409);
  const due = await request(path, "2026-08-02T00:00:00.000Z", { idempotency_key: "cleanup_policy", retention_days: 1 });
  expect(due.status).toBe(202);
  expect(await due.json()).toMatchObject({ retention_days: 1, eligible_at: "2026-08-02T00:00:00.000Z" });
  const conflict = await request(path, "2026-09-01T00:00:00.000Z", {
    idempotency_key: "cleanup_policy",
    retention_days: 30,
  });
  expect(conflict.status).toBe(409);
});

test("the production system clock ignores an owner supplied future deletion time", async () => {
  const now = new Date().toISOString();
  await seedRunFixtureStatement(env.CATALOGUE_DB, {
    id: "cleanup_server_clock",
    state: "failed",
    failure_code: "synthetic_capture_failure",
    started_at: now,
    terminal_at: now,
  }).run();
  const worker = (await import("../src/index")).default;
  const response = await worker.fetch(
    new Request("https://card-keepr.invalid/v1/ingestion-runs/cleanup_server_clock/evidence-cleanup", {
      method: "POST",
      headers: {
        authorization: "Bearer vitest-administration-key",
        "content-type": "application/json",
        "x-keepr-test-now": new Date(Date.now() + 366 * 86400000).toISOString(),
      },
      body: JSON.stringify({ idempotency_key: "cleanup_server_clock" }),
    }),
    { ...env, ADMINISTRATION_CLOCK_MODE: "system" },
  );
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "evidence_cleanup_not_eligible" });
});

test.each(["capture", "staging"] as const)(
  "concurrent conflicting %s starts cannot silently share an idempotency key",
  async (scope) => {
    for (const owner of ["cleanup_race_one", "cleanup_race_two"]) {
      if (scope === "capture") await terminalRun(owner);
      else await abandonedStaging(owner, `publication-artifacts/${owner}`);
    }
    const replies = await Promise.all(
      ["cleanup_race_one", "cleanup_race_two"].map(async (owner) =>
        request(
          scope === "capture"
            ? `/v1/ingestion-runs/${owner}/evidence-cleanup`
            : `/v1/reconciliation-operations/${owner}/evidence-cleanup`,
          scope === "staging" ? await stagingCleanupAt(owner) : "2026-08-31T00:00:00.000Z",
          { idempotency_key: "cleanup_race" },
        ),
      ),
    );
    expect(replies.map((reply) => reply.status).sort()).toEqual([202, 409]);
    expect(await replies.find((reply) => reply.status === 409)!.json()).toMatchObject({ code: "idempotency_conflict" });
  },
);

test("a staging batch waits for late writes and leaves only ambiguous writer tickets open", async () => {
  await activeStaging("staging_batch");
  const { catalogueStore, writeStagingObjects } = await import("../../../src/catalogue/shared");
  let releaseLate!: () => void;
  const late = new Promise<void>((resolve) => {
    releaseLate = resolve;
  });
  let completeKnown!: () => void;
  let failKnown!: (error: unknown) => void;
  const completed = new Promise<void>((resolve, reject) => {
    completeKnown = resolve;
    failKnown = reject;
  });
  const keys = [
    "publication-artifacts/lost-batch",
    "publication-artifacts/late-batch",
    "publication-artifacts/known-batch",
  ];
  const bucket = new Proxy(env.CATALOGUE_EXPORTS, {
    get(target, property) {
      if (property === "put")
        return async (...args: Parameters<R2Bucket["put"]>) => {
          try {
            const ticket = await env.CATALOGUE_DB.prepare(
              "SELECT object_key,completed_at FROM staging_object_writes WHERE token=?",
            )
              .bind(args[2]?.customMetadata?.cleanup_writer_token)
              .first();
            expect(ticket).toEqual({ object_key: args[0], completed_at: null });
            if (args[0] === keys[1]) await late;
            const result = await target.put(...args);
            if (args[0] === keys[0]) throw new Error("synthetic ambiguous batch write");
            if (args[0] === keys[2]) completeKnown();
            return result;
          } catch (error) {
            if (args[0] === keys[2]) failKnown(error);
            throw error;
          }
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  let settled = false;
  const writing = writeStagingObjects(
    catalogueStore(env.CATALOGUE_DB),
    bucket,
    "CATALOGUE_EXPORTS",
    "staging_batch",
    keys.map((key) => ({ key, content: "retained bytes", options: { onlyIf: { etagDoesNotMatch: "*" } } })),
  ).then(
    () => {
      settled = true;
      return null;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  let outcome: unknown;
  try {
    await Promise.race([completed, writing]);
    const open = await env.CATALOGUE_DB.prepare(
      "SELECT object_key FROM staging_object_writes WHERE preparation_id='staging_batch' AND completed_at IS NULL",
    ).all();
    expect(open.results).toHaveLength(3);
    expect(settled).toBe(false);
  } finally {
    releaseLate();
    outcome = await writing;
  }
  expect(outcome).toMatchObject({ message: "synthetic ambiguous batch write" });
  expect(
    await env.CATALOGUE_DB.prepare(
      "SELECT object_key FROM staging_object_writes WHERE preparation_id='staging_batch' AND completed_at IS NULL",
    ).all(),
  ).toMatchObject({ results: [{ object_key: keys[0] }] });
  for (const key of keys) expect(await (await env.CATALOGUE_EXPORTS.get(key))!.text()).toBe("retained bytes");
});

test("staging retry settles only the writer token actually observed in object metadata", async () => {
  await activeStaging("staging_lost_response");
  const { catalogueStore, trackedStagingBucket } = await import("../../../src/catalogue/shared");
  const key = "publication-artifacts/lost-put";
  const bucket = new Proxy(env.CATALOGUE_EXPORTS, {
    get(target, property) {
      if (property === "put")
        return async (...args: Parameters<R2Bucket["put"]>) => {
          await target.put(...args);
          throw new Error("synthetic lost put response");
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await expect(
    trackedStagingBucket(catalogueStore(env.CATALOGUE_DB), bucket, "CATALOGUE_EXPORTS", "staging_lost_response").put(
      key,
      "same bytes",
      { onlyIf: { etagDoesNotMatch: "*" } },
    ),
  ).rejects.toThrow("synthetic lost put response");
  await env.CATALOGUE_DB.prepare(
    `INSERT INTO staging_object_writes VALUES ('unrelated-lost-writer','staging_lost_response','CATALOGUE_EXPORTS',?,0,'2026-09-08T00:00:00.000Z',NULL)`,
  )
    .bind(key)
    .run();
  await trackedStagingBucket(
    catalogueStore(env.CATALOGUE_DB),
    env.CATALOGUE_EXPORTS,
    "CATALOGUE_EXPORTS",
    "staging_lost_response",
  ).put(key, "same bytes", { onlyIf: { etagDoesNotMatch: "*" } });
  expect(
    await env.CATALOGUE_DB.prepare(
      "SELECT token FROM staging_object_writes WHERE object_key=? AND completed_at IS NULL",
    )
      .bind(key)
      .all(),
  ).toMatchObject({ results: [{ token: "unrelated-lost-writer" }] });
});

test("a new staging identity cannot replace corrupt pre-registry bytes or receipt a partial artifact batch", async () => {
  await activeStaging("staging_unregistered");
  const { catalogueStore } = await import("../../../src/catalogue/shared");
  const { publicationObjectBatch } = await import("../../../src/catalogue/reconciliation/publication-artifact-storage");
  const objects = publicationObjectBatch(
    catalogueStore(env.CATALOGUE_DB),
    env.CATALOGUE_EXPORTS,
    "staging_unregistered",
  );
  const conflict = await objects.stage("expected bytes");
  const fresh = await objects.stage("fresh bytes");
  await env.CATALOGUE_EXPORTS.put(conflict.object_key, "corrupt bytes");
  await expect(objects.flush()).rejects.toMatchObject({ code: "publication_artifact_corrupt" });
  expect(await (await env.CATALOGUE_EXPORTS.get(conflict.object_key))!.text()).toBe("corrupt bytes");
  expect(await (await env.CATALOGUE_EXPORTS.get(fresh.object_key))!.text()).toBe("fresh bytes");
  expect(() => conflict.receipt()).toThrow("has not been verified");
  expect(() => fresh.receipt()).toThrow("has not been verified");
  expect(
    await env.CATALOGUE_DB.prepare(
      "SELECT token FROM staging_object_writes WHERE preparation_id='staging_unregistered' AND completed_at IS NULL",
    ).all(),
  ).toMatchObject({ results: [] });
});
