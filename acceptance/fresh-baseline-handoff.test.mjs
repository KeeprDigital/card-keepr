import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { build } from "esbuild";
import { validateDispatchAndWriteSql } from "../scripts/production-release.mjs";
import { runFreshBaselineRelease } from "../scripts/fresh-baseline-release.mjs";
import { destinationReleaseSql, handoffReadSql, phaseSql, transferSql } from "../scripts/fresh-baseline-handoff.mjs";
import { d1Adapter } from "./helpers/query-helpers/sqlite-d1-adapter.mjs";
import * as queries from "./helpers/query-helpers/fresh-baseline.mjs";

const bundle = await build({
  stdin: {
    contents:
      'export { prepareProductionRelease } from "./src/catalogue/ingestion/production-release"; export { catalogueStore } from "./src/catalogue/shared/catalogue-store-repository";',
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
});
const runtime = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text + "\n//# sourceURL=fresh-baseline-runtime.mjs").toString("base64")}`
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
  template.close();
  // Real SQL export/import of a local test fold. This is synthetic protocol
  // evidence; it is not the final #136 fold, a provider export, or live readiness.
  const baseline = execFileSync("/usr/bin/sqlite3", [join(directory, "template.sqlite"), ".dump"], {
    maxBuffer: 16 * 1024 * 1024,
    encoding: "utf8",
  });
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
    claim: async () => execute(source, await readFile(`${directory}/fresh-claim.sql`, "utf8")),
    installBaseline: async () => {
      destination.exec(baseline);
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
