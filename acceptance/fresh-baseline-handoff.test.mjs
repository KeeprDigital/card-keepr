import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";
import test from "node:test";
import { build } from "esbuild";
import { validateDispatchAndWriteSql } from "../scripts/production-release.mjs";
import { cancelFreshBaselineRelease, runFreshBaselineRelease } from "../scripts/fresh-baseline-release.mjs";
import {
  renewHandoffSql,
  cancellationSql,
  destinationReleaseSql,
  handoffReadSql,
  phaseSql,
  transferSql,
} from "../scripts/fresh-baseline-handoff.mjs";
import {
  correctionRowsSql,
  correctionImportSql,
  claimCorrectionSql,
  correctionPhaseSql,
  runFreshBaselineCorrection,
} from "../scripts/fresh-baseline-correction.mjs";
import { d1Adapter } from "./helpers/query-helpers/sqlite-d1-adapter.mjs";
import * as queries from "./helpers/query-helpers/fresh-baseline.mjs";

const bundle = await build({
  stdin: {
    contents:
      'export { resolveFreshBaselineCorrection } from "./src/catalogue/ingestion/fresh-baseline-correction"; export { prepareProductionRelease } from "./src/catalogue/ingestion/production-release"; export { catalogueStore } from "./src/catalogue/shared/catalogue-store-repository"; export { prepareCardSearchForD1ExportStatements, reconstructCardSearchAfterD1RestoreStatements } from "./src/catalogue/backup-recovery/card-search-recovery-statements";',
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
});
const runtime = await import(
  `data:text/javascript;base64,${Buffer.from(`${bundle.outputFiles[0].text}\n//# sourceURL=fresh-baseline-runtime.mjs`).toString("base64")}`
);
const migrations = await Promise.all(
  (await readdir("migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFile(`migrations/${f}`, "utf8")),
);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) =>
  value && typeof value === "object"
    ? Array.isArray(value)
      ? value.map(canonical)
      : Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, canonical(value[k])]),
        )
    : value;

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), "keepr-fresh-baseline-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = new DatabaseSync(join(directory, "source.sqlite"));
  for (const sql of migrations) source.exec(sql);
  const template = new DatabaseSync(join(directory, "template.sqlite"));
  for (const sql of migrations) template.exec(sql);
  queries.lowerBaselineLevel(template);
  for (const sql of runtime.prepareCardSearchForD1ExportStatements) template.exec(sql);
  template.close();
  // Real SQL export/import of a local test fold. This is synthetic protocol
  // evidence; it is not the final #136 fold, a provider export, or live readiness.
  const exportedBaseline = execFileSync("/usr/bin/sqlite3", [join(directory, "template.sqlite"), ".dump"], {
    maxBuffer: 16 * 1024 * 1024,
    encoding: "utf8",
  });
  const baseline = `${exportedBaseline}\n${runtime.reconstructCardSearchAfterD1RestoreStatements.join(";\n")};`;
  const destination = new DatabaseSync(join(directory, "destination.sqlite"));
  t.after(() => {
    source.close();
    destination.close();
  });
  const target = {
    cloudflare_account_id: "account_239",
    worker_scripts: ["card-keepr-api", "card-keepr-ingestion"],
    d1_databases: [{ name: "catalogue", id: "source_database" }],
    r2_buckets: ["shared-evidence"],
  };
  const plan = canonical({
    release_id: "release_239",
    idempotency_key: "prepare_239",
    expected_current_revision_id: "catrev_spine_000",
    expected_head_sha: "a".repeat(40),
    expected_actor: "owner[bot]",
    expected_migration_level: 27,
    production_target: target,
    production_target_digest: sha(JSON.stringify(canonical(target))),
    bootstrap: true,
    recovery_bookmark: null,
    recovery_backup_attempt_id: null,
    smoke_targets: null,
    retained_revision_evidence: null,
    replacement_handoff: null,
    fresh_baseline_handoff: {
      destination_database_id: "fresh_database",
      baseline_sha256: sha(baseline),
      destination_migration_level: 1,
      scope: "fresh_database_regeneration",
    },
  });
  const preparation = await runtime.prepareProductionRelease(
    runtime.catalogueStore(d1Adapter(source)),
    plan,
    target,
    new Date().toISOString(),
  );
  const environment = Object.fromEntries(
    Object.entries(preparation.dispatch_inputs).map(([key, value]) => [key.toUpperCase(), value]),
  );
  environment.HANDOFF_EXECUTION_ID = "synthetic_execution_239";
  await validateDispatchAndWriteSql(environment, directory);
  const execute = (db, sql) => {
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const databases = { source, destination };
  const read = (role) => {
    try {
      return databases[role].prepare(handoffReadSql(environment, role)).get() ?? null;
    } catch (error) {
      if (role === "destination" && error.message.includes("no such table")) return null;
      throw error;
    }
  };
  const versions = [
    { worker: "card-keepr-api", version_id: "synthetic_api" },
    { worker: "card-keepr-ingestion", version_id: "synthetic_ingestion" },
  ];
  let activations = 0;
  const adapter = {
    read: async (role) => read(role),
    cancellation: async () => ({
      ...preparation,
      dispatch_inputs: { ...preparation.dispatch_inputs, operation: "cancel_fresh_baseline_handoff" },
    }),
    observeSource: async () => ({ synthetic_provider_observation: true, source_database_id: "source_database" }),
    cancel: async (role, evidence) => execute(databases[role], cancellationSql(environment, role, evidence)),
    renew: async () => {
      for (const role of ["source", "destination"])
        if (read(role)) execute(databases[role], renewHandoffSql(environment, role));
    },
    claim: async () => execute(source, await readFile(`${directory}/fresh-claim.sql`, "utf8")),
    installBaseline: async () => {
      if (queries.schemaRows(destination).all().length === 0) destination.exec(baseline);
      return { baseline_sha256: sha(baseline), migration_level: 1, integrity: "ok", foreign_keys: "ok" };
    },
    transfer: async (row) => execute(destination, transferSql(environment, JSON.parse(JSON.stringify(row)))),
    advance: async (role, from, evidence) => execute(databases[role], phaseSql(environment, role, from, evidence)),
    uploadAndVerify: async () => versions,
    activate: async () => {
      assert.ok(read("source").phase >= 4);
      assert.ok(read("destination").phase >= 4);
      activations++;
    },
    observe: async () => ({
      worker_database_ids: { "card-keepr-api": "fresh_database", "card-keepr-ingestion": "fresh_database" },
    }),
    smoke: async () => ({
      contract: "card-keepr-production-bootstrap-smoke@1",
      revision_id: "catrev_spine_000",
      checks: 6,
    }),
    accept: async (row) => execute(destination, destinationReleaseSql(environment, JSON.parse(JSON.stringify(row)))),
  };
  return { source, destination, environment, adapter, read, activations: () => activations, execute };
}

test("two SQL databases transfer only prepared authority and retire source before destination opens", async (t) => {
  const f = await setup(t);
  queries.seedSharedReference(f.source).run();
  const result = await runFreshBaselineRelease(f.environment, f.adapter);
  assert.equal(result.state, "handoff_accepted");
  assert.equal(result.go_live, false);
  assert.equal(f.read("source").phase, 6);
  assert.equal(f.read("destination").phase, 6);
  assert.throws(() => queries.mutateCatalogue(f.source).run(), /fresh_baseline_mutation_fenced/);
  assert.throws(() => queries.cleanupLease(f.source).run(), /fresh_baseline_mutation_fenced/);
  assert.throws(() => queries.trySearchMaintenance(f.source).run(), /fresh_baseline_mutation_fenced/);
  queries.mutateCatalogue(f.destination).run();
  assert.equal(queries.sharedReferences(f.source).all().length, 1);
  assert.throws(() => queries.attemptSharedDelete(f.destination).run(), /fresh_baseline_retained_source_storage/);
  assert.deepEqual(await runFreshBaselineRelease(f.environment, f.adapter), result);
});

test("every durable phase boundary can restart after an ambiguous successful write and expired lease", async (t) => {
  for (let stop = 1; stop <= 12; stop++)
    await t.test(`interruption ${stop}`, async (t) => {
      const f = await setup(t);
      let writes = 0;
      const interrupted = { ...f.adapter };
      for (const name of ["claim", "transfer", "advance", "accept"])
        interrupted[name] = async (...args) => {
          const result = await f.adapter[name](...args);
          if (++writes === stop) throw new Error("synthetic_lost_response");
          return result;
        };
      try {
        await runFreshBaselineRelease(f.environment, interrupted);
      } catch (error) {
        assert.match(error.message, /synthetic_lost_response/);
      }
      if (f.read("source")) {
        queries.expireLease(f.source).run();
        assert.throws(() => queries.mutateCatalogue(f.source).run(), /fresh_baseline_mutation_fenced/);
      }
      const result = await runFreshBaselineRelease(f.environment, f.adapter);
      assert.equal(result.state, "handoff_accepted");
    });
});

test("unsettled synthetic writer rejects claim atomically, not just destination activation", async (t) => {
  const f = await setup(t);
  queries.foreignKeys(f.source, false);
  queries.forceUnsettledWriter(f.source).run();
  await assert.rejects(() => f.adapter.claim(), /fresh_baseline_not_quiescent/);
  assert.equal(f.read("source"), null);
  assert.equal(f.activations(), 0);
  queries.completeUnsettledWriter(f.source).run();
  await f.adapter.claim();
  assert.equal(f.read("source").phase, 1);
});

test("activation or smoke failures preserve both fences and accept only a proved source retirement", async (t) => {
  for (const failure of ["activate", "observe", "smoke"])
    await t.test(failure, async (t) => {
      const f = await setup(t);
      await assert.rejects(
        () =>
          runFreshBaselineRelease(f.environment, {
            ...f.adapter,
            [failure]: async () => {
              throw new Error("synthetic_provider_failure");
            },
          }),
        /synthetic_provider_failure/,
      );
      for (const db of [f.source, f.destination]) {
        queries.expireLease(db).run();
        assert.throws(() => queries.mutateCatalogue(db).run(), /fresh_baseline_mutation_fenced/);
      }
      assert.throws(() => destinationReleaseSql(f.environment, f.read("source")), /source_not_retired/);
      await runFreshBaselineRelease(f.environment, f.adapter);
    });
});

test("expired execution must renew, and a replaced execution cannot advance or cancel", async (t) => {
  const f = await setup(t);
  await f.adapter.claim();
  const old = { ...f.environment };
  queries.expireLease(f.source).run();
  assert.throws(
    () => f.execute(f.source, phaseSql(old, "source", 1, { baseline: "synthetic" })),
    /fresh_baseline_guard_failed/,
  );
  f.environment.HANDOFF_EXECUTION_ID = "synthetic_replacement_execution";
  await f.adapter.renew();
  assert.throws(
    () => f.execute(f.source, phaseSql(old, "source", 1, { baseline: "synthetic" })),
    /fresh_baseline_guard_failed/,
  );
  assert.throws(() => f.execute(f.source, renewHandoffSql(old, "source")), /fresh_baseline_transition_invalid/);
  await f.adapter.advance("source", 1, { baseline: "synthetic" });
});

test("pre-intent cancellation quarantines destination and proves source traffic before reopening", async (t) => {
  const f = await setup(t);
  await assert.rejects(
    () =>
      runFreshBaselineRelease(f.environment, {
        ...f.adapter,
        uploadAndVerify: async () => {
          throw new Error("synthetic_upload_failure");
        },
      }),
    /synthetic_upload_failure/,
  );
  queries.recordCancellation(f.source, f.environment.DISPATCH_DIGEST, await f.adapter.cancellation());
  await assert.rejects(
    () =>
      cancelFreshBaselineRelease(f.environment, {
        ...f.adapter,
        observeSource: async () => {
          throw new Error("synthetic_destination_traffic");
        },
      }),
    /synthetic_destination_traffic/,
  );
  assert.throws(() => queries.mutateCatalogue(f.source).run(), /fresh_baseline_mutation_fenced/);
  await cancelFreshBaselineRelease(f.environment, f.adapter);
  assert.equal(f.read("destination").phase, 7);
  assert.equal(f.read("source").phase, 7);
  queries.mutateCatalogue(f.source).run();
  assert.throws(() => queries.mutateCatalogue(f.destination).run(), /fresh_baseline_mutation_fenced/);
  assert.equal((await cancelFreshBaselineRelease(f.environment, f.adapter)).state, "handoff_cancelled");
  await assert.rejects(() => runFreshBaselineRelease(f.environment, f.adapter), /fresh_baseline_handoff_cancelled/);
});

test("any durable activation intent rejects cancellation, even if provider activation failed", async (t) => {
  const f = await setup(t);
  await assert.rejects(
    () =>
      runFreshBaselineRelease(f.environment, {
        ...f.adapter,
        activate: async () => {
          throw new Error("synthetic_activation_failure");
        },
      }),
    /synthetic_activation_failure/,
  );
  await assert.rejects(
    () => cancelFreshBaselineRelease(f.environment, f.adapter),
    /fresh_baseline_cancellation_unsafe/,
  );
});

test("SQL restoration preserves retired-source evidence and destination shared-storage protection", async (t) => {
  const f = await setup(t);
  queries.seedSharedReference(f.source).run();
  await runFreshBaselineRelease(f.environment, f.adapter);
  const directory = await mkdtemp(join(tmpdir(), "keepr-restored-handoff-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [role, original] of [
    ["source", f.source],
    ["destination", f.destination],
  ]) {
    const copied = join(directory, `${role}.sqlite`);
    await sqliteBackup(original, copied);
    const backup = new DatabaseSync(copied);
    // Search indexes are disposable in the established SQL backup contract. Only
    // this disposable export copy is prepared; neither authority database changes.
    for (const sql of runtime.prepareCardSearchForD1ExportStatements) backup.exec(sql);
    backup.close();
    const exported = execFileSync("/usr/bin/sqlite3", [copied, ".dump"], {
      maxBuffer: 16 * 1024 * 1024,
      encoding: "utf8",
    });
    const restored = new DatabaseSync(":memory:");
    t.after(() => restored.close());
    restored.exec(exported);
    if (role === "source") {
      assert.equal(queries.sharedReferences(restored).all().length, 1);
      assert.throws(() => queries.mutateCatalogue(restored).run(), /fresh_baseline_mutation_fenced/);
    } else {
      queries.mutateCatalogue(restored).run();
      assert.throws(() => queries.attemptSharedDelete(restored).run(), /fresh_baseline_retained_source_storage/);
    }
  }
});

async function approveCorrection(f, role, key, head) {
  const db = role === "source" ? f.source : f.destination;
  const original = JSON.parse(f.read(role).preparation_json);
  const choices = { expected_head_sha: head.repeat(40), idempotency_key: key };
  const store = runtime.catalogueStore(d1Adapter(db));
  const preview = await runtime.resolveFreshBaselineCorrection(
    store,
    original,
    choices,
    undefined,
    true,
    new Date().toISOString(),
  );
  const response = await runtime.resolveFreshBaselineCorrection(
    store,
    original,
    choices,
    preview.confirmation,
    false,
    new Date().toISOString(),
  );
  return {
    ...f.environment,
    EXPECTED_HEAD_SHA: response.dispatch_inputs.expected_head_sha,
    HANDOFF_OPERATION: "correct_fresh_baseline_handoff",
    HANDOFF_CORRECTION_JSON: response.dispatch_inputs.correction_json,
    HANDOFF_CORRECTION_DIGEST: response.dispatch_inputs.correction_digest,
    HANDOFF_EXECUTION_ID: key,
  };
}
function correctionAdapter(f, environment) {
  const db = (role) => (role === "source" ? f.source : f.destination);
  return {
    ...f.adapter,
    correctionRows: async (role) => db(role).prepare(correctionRowsSql(environment)).all(),
    importCorrection: async (role, rows, existing) =>
      f.execute(db(role), correctionImportSql(environment, rows, existing)),
    claimCorrection: async (role) => f.execute(db(role), claimCorrectionSql(environment)),
    correctionPhase: async (role, from, evidence) =>
      f.execute(db(role), correctionPhaseSql(environment, from, evidence)),
    advance: async (role, from, evidence) => f.execute(db(role), phaseSql(environment, role, from, evidence)),
    accept: async (source) => f.execute(f.destination, destinationReleaseSql(environment, source)),
    uploadAndVerify: async () => [
      { worker: "card-keepr-api", version_id: environment.EXPECTED_HEAD_SHA },
      { worker: "card-keepr-ingestion", version_id: environment.EXPECTED_HEAD_SHA },
    ],
  };
}
test("new SHA requires exact linked owner approval and supersedes original execution after intent", async (t) => {
  const f = await setup(t);
  await assert.rejects(
    runFreshBaselineRelease(f.environment, {
      ...f.adapter,
      activate: async () => {
        throw new Error("activation_failed");
      },
    }),
    /activation_failed/,
  );
  const environment = await approveCorrection(f, "source", "repair_239", "b");
  assert.throws(() => f.execute(f.source, renewHandoffSql(f.environment, "source")), /guard_failed/);
  assert.throws(() => f.execute(f.source, phaseSql(f.environment, "source", 4, {})), /guard_failed/);
  const adapter = correctionAdapter(f, environment);
  const result = await runFreshBaselineCorrection(environment, adapter);
  assert.equal(result.state, "handoff_accepted");
  assert.equal(f.read("source").phase, 6);
  assert.equal(f.read("destination").phase, 6);
  assert.deepEqual(await runFreshBaselineCorrection(environment, adapter), result);
  assert.throws(() => queries.mutateCatalogue(f.source).run(), /mutation_fenced/);
});
test("correction resumes every persisted boundary and revokes a superseded repair", async (t) => {
  for (let stop = 1; stop <= 10; stop++)
    await t.test(`repair interruption ${stop}`, async (t) => {
      const f = await setup(t);
      await assert.rejects(
        runFreshBaselineRelease(f.environment, {
          ...f.adapter,
          activate: async () => {
            throw new Error("activation_failed");
          },
        }),
        /activation_failed/,
      );
      const environment = await approveCorrection(f, "destination", "repair_239", "b");
      const adapter = correctionAdapter(f, environment);
      const interrupted = { ...adapter };
      let writes = 0;
      for (const name of ["importCorrection", "claimCorrection", "correctionPhase", "advance", "accept"])
        interrupted[name] = async (...args) => {
          const result = await adapter[name](...args);
          if (++writes === stop) throw new Error("lost_response");
          return result;
        };
      await assert.rejects(runFreshBaselineCorrection(environment, interrupted), /lost_response/);
      const result = await runFreshBaselineCorrection(environment, adapter);
      assert.equal(result.state, "handoff_accepted");
    });
  await t.test("a second confirmed SHA revokes the first repair", async (t) => {
    const f = await setup(t);
    await assert.rejects(
      runFreshBaselineRelease(f.environment, {
        ...f.adapter,
        activate: async () => {
          throw new Error("activation_failed");
        },
      }),
      /activation_failed/,
    );
    const first = await approveCorrection(f, "source", "repair_first", "b");
    await assert.rejects(
      runFreshBaselineCorrection(first, {
        ...correctionAdapter(f, first),
        activate: async () => {
          throw new Error("activation_failed");
        },
      }),
      /activation_failed/,
    );
    const second = await approveCorrection(f, "destination", "repair_second", "c");
    assert.throws(() => f.execute(f.destination, correctionPhaseSql(first, 1, { stale: true })), /owner_changed/);
    await assert.rejects(runFreshBaselineCorrection(first, correctionAdapter(f, first)), /chain_invalid|superseded/);
    assert.equal((await runFreshBaselineCorrection(second, correctionAdapter(f, second))).state, "handoff_accepted");
  });
});

test("a separately approved correction repairs source intent with destination still transferred", async (t) => {
  const f = await setup(t);
  await assert.rejects(
    runFreshBaselineRelease(f.environment, {
      ...f.adapter,
      advance: async (role, from, evidence) => {
        await f.adapter.advance(role, from, evidence);
        if (role === "source" && from === 3) throw new Error("lost_source_intent_response");
      },
    }),
    /lost_source_intent_response/,
  );
  assert.equal(f.read("source").phase, 4);
  assert.equal(f.read("destination").phase, 3);
  const environment = await approveCorrection(f, "source", "split_repair", "b");
  assert.equal(
    (await runFreshBaselineCorrection(environment, correctionAdapter(f, environment))).state,
    "handoff_accepted",
  );
});
