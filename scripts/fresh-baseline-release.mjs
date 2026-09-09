#!/usr/bin/env node
import {
  correctionRowsSql,
  correctionImportSql,
  claimCorrectionSql,
  correctionPhaseSql,
  runFreshBaselineCorrection,
} from "./fresh-baseline-correction.mjs";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { readWorkerConfig } from "../cli/lib/config.mjs";
import { executeSqlFile } from "./production-release-d1.mjs";
import { writeReplacementConfigs } from "./production-release.mjs";
import {
  observeCatalogueBindings,
  observeReleaseActivation,
  verifyUploadedVersion,
} from "./production-release-provider.mjs";
import { runBootstrapSmoke } from "./production-smoke.mjs";
import {
  cancellationReadSql,
  cancellationSql,
  handoffPhases as phases,
  activationIntent,
  renewHandoffSql,
  baselineBytes,
  destinationReleaseSql,
  handoffPlan,
  handoffReadSql,
  phaseSql,
  transferSql,
} from "./fresh-baseline-handoff.mjs";

/** Each adapter action is an actual release seam; tests interrupt between calls. */
export async function runFreshBaselineRelease(environment, adapter) {
  const plan = handoffPlan(environment);
  let source = await adapter.read("source");
  if (source?.phase === 7) throw new Error("fresh_baseline_handoff_cancelled");
  if (source !== null) {
    const destination = await adapter.read("destination");
    if (source.phase !== phases.accepted || destination?.phase !== phases.accepted) await adapter.renew();
  }
  if (source === null) {
    await adapter.claim();
    source = await adapter.read("source");
  }
  if (source.phase === phases.claimed) {
    const baseline = await adapter.installBaseline();
    await adapter.advance("source", phases.claimed, baseline);
    source = await adapter.read("source");
  }
  let destination = await adapter.read("destination");
  if (destination === null) {
    if (source.phase !== phases.baselineVerified) throw new Error("fresh_baseline_destination_authority_missing");
    await adapter.transfer(source);
    destination = await adapter.read("destination");
  }
  if (destination.phase === phases.baselineVerified)
    await adapter.advance("destination", phases.baselineVerified, { transferred: environment.DISPATCH_DIGEST });
  if (source.phase === phases.baselineVerified)
    await adapter.advance("source", phases.baselineVerified, { transferred: environment.DISPATCH_DIGEST });
  source = await adapter.read("source");
  destination = await adapter.read("destination");
  // Upload is safe to retry before intent. Existing exact tags must resolve to
  // one version; an ambiguous upload fails closed instead of creating a pair.
  if (source.phase === phases.transferred || destination.phase === phases.transferred) {
    const versions = await adapter.uploadAndVerify();
    if (source.phase === phases.transferred) await adapter.advance("source", phases.transferred, { versions });
    else if (!isDeepStrictEqual(JSON.parse(source.evidence_json).at(-1), { versions }))
      throw new Error("fresh_baseline_version_changed");
    if (destination.phase === phases.transferred)
      await adapter.advance("destination", phases.transferred, { versions });
  }
  source = await adapter.read("source");
  destination = await adapter.read("destination");
  if (source.phase === phases.activationIntended || destination.phase === phases.activationIntended) {
    // Both durable intents precede the first provider activation request.
    if (source.phase < phases.activationIntended || destination.phase < phases.activationIntended)
      throw new Error("fresh_baseline_activation_not_authorized");
    const intent = activationIntent(source);
    if (!isDeepStrictEqual(intent, activationIntent(destination))) throw new Error("fresh_baseline_intent_mismatch");
    await adapter.activate(intent.versions);
    const binding = await adapter.observe(intent.versions);
    const smoke = await adapter.smoke();
    const observed = { binding, smoke };
    if (source.phase === phases.activationIntended)
      await adapter.advance("source", phases.activationIntended, observed);
    if (destination.phase === phases.activationIntended)
      await adapter.advance("destination", phases.activationIntended, observed);
  }
  source = await adapter.read("source");
  destination = await adapter.read("destination");
  if (source.phase === phases.bindingObserved) {
    if (destination.phase !== phases.bindingObserved) throw new Error("fresh_baseline_destination_not_observed");
    await adapter.advance("source", phases.bindingObserved, {
      retired: true,
      destination_database_id: plan.fresh_baseline_handoff.destination_database_id,
    });
    source = await adapter.read("source");
  }
  if (source.phase !== phases.accepted) throw new Error("fresh_baseline_source_not_retired");
  if (destination.phase === phases.bindingObserved) await adapter.accept(source);
  destination = await adapter.read("destination");
  if (destination.phase !== phases.accepted) throw new Error("fresh_baseline_destination_not_accepted");
  return { release_id: plan.release_id, state: "handoff_accepted", go_live: false, source_retained: true };
}

export async function cancelFreshBaselineRelease(environment, adapter) {
  const plan = handoffPlan(environment);
  const authorization = await adapter.cancellation();
  if (
    !authorization ||
    authorization.dispatch_digest !== environment.DISPATCH_DIGEST ||
    authorization.prepared_plan_json !== environment.PREPARED_PLAN_JSON ||
    authorization.dispatch_inputs?.operation !== "cancel_fresh_baseline_handoff"
  )
    throw new Error("fresh_baseline_cancellation_not_authorized");
  const source = await adapter.read("source");
  const destination = await adapter.read("destination");
  if (source?.phase === 7)
    return { release_id: plan.release_id, state: "handoff_cancelled", destination_quarantined: true };
  if (
    !source ||
    source.phase >= phases.activationIntended ||
    (destination !== null && destination.phase >= phases.activationIntended && destination.phase !== 7)
  )
    throw new Error("fresh_baseline_cancellation_unsafe");
  await adapter.renew();
  const observation = await adapter.observeSource();
  const evidence = { source_still_active: true, observation };
  if (destination !== null && destination.phase !== 7) await adapter.cancel("destination", evidence);
  await adapter.cancel("source", evidence);
  return { release_id: plan.release_id, state: "handoff_cancelled", destination_quarantined: true };
}

async function command(args) {
  await new Promise((resolve, reject) => {
    const child = spawn("npx", ["--no-install", "wrangler", ...args], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`wrangler_release_step_failed:${code}`))));
  });
}

export async function providerAdapter(environment, directory) {
  const plan = handoffPlan(environment);
  const fresh = plan.fresh_baseline_handoff;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const configs = { source: "apps/ingestion/wrangler.jsonc", destination: "apps/ingestion/wrangler.fresh.json" };
  const apiConfig = "apps/api/wrangler.fresh.json";
  await writeReplacementConfigs(fresh.destination_database_id, apiConfig, configs.destination);
  const sql = async (role, text) => {
    const path = `${directory}/fresh-${role}.sql`;
    await writeFile(path, text, { mode: 0o600 });
    return executeSqlFile(environment, { configPath: configs[role], sqlPath: path });
  };
  const read = async (role) => {
    // The fresh database initially has no schema. Only that absence is allowed.
    const tables = await sql(
      role,
      "SELECT name FROM sqlite_schema WHERE type='table' AND name='fresh_baseline_handoffs';",
    );
    if (tables[0].results.length === 0) {
      if (role === "source") throw new Error("fresh_baseline_prerequisite_not_released");
      return null;
    }
    const rows = (await sql(role, handoffReadSql(environment, role)))[0].results;
    if (rows.length > 1) throw new Error("fresh_baseline_authority_ambiguous");
    return rows[0] ?? null;
  };
  const workerConfigurations = [
    ["card-keepr-api", apiConfig, "api"],
    ["card-keepr-ingestion", configs.destination, "ingestion"],
  ];
  const versionEnvironment = (worker, path, suffix) => ({
    ...environment,
    RELEASE_WORKER: worker,
    RELEASE_WORKER_CONFIG: path,
    RELEASE_VERSION_TAG: environment.HANDOFF_CORRECTION_DIGEST
      ? `correction-${environment.HANDOFF_CORRECTION_DIGEST.slice(0, 32)}-${suffix}`
      : `release-${plan.release_id}-${suffix}`,
  });
  return {
    read,
    correctionRows: async (role) => (await sql(role, correctionRowsSql(environment)))[0].results,
    importCorrection: (role, records, existing) => sql(role, correctionImportSql(environment, records, existing)),
    claimCorrection: (role) => sql(role, claimCorrectionSql(environment)),
    correctionPhase: (role, from, evidence) => sql(role, correctionPhaseSql(environment, from, evidence)),
    async cancellation() {
      const rows = (await sql("source", cancellationReadSql(environment)))[0].results;
      return rows.length === 1 ? JSON.parse(rows[0].response_json) : null;
    },
    observeSource: () => observeReleaseActivation(environment, null, ["apps/api/wrangler.jsonc", configs.source]),
    cancel: (role, evidence) => sql(role, cancellationSql(environment, role, evidence)),
    async renew() {
      for (const role of ["source", "destination"])
        if (await read(role)) await sql(role, renewHandoffSql(environment, role));
    },
    claim: () => executeSqlFile(environment, { configPath: configs.source, sqlPath: `${directory}/fresh-claim.sql` }),
    async installBaseline() {
      const files = (await readdir("migrations")).filter((name) => name.endsWith(".sql"));
      if (files.length !== 1 || files[0] !== "0001_baseline.sql")
        throw new Error("fresh_baseline_final_fold_not_present");
      const bytes = await baselineBytes(environment, "migrations/0001_baseline.sql");
      const model = new DatabaseSync(":memory:");
      try {
        model.exec(bytes.toString("utf8"));
        const schemaQuery =
          "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_migrations%' AND name NOT LIKE '_cf_%' ORDER BY type,name";
        const expectedSchema = model.prepare(schemaQuery).all();
        const existing = (await sql("destination", schemaQuery))[0].results;
        if (existing.length === 0)
          await command(["d1", "migrations", "apply", "CATALOGUE_DB", "--remote", "--config", configs.destination]);
        const installed = (await sql("destination", schemaQuery))[0].results;
        if (!isDeepStrictEqual(JSON.parse(JSON.stringify(expectedSchema)), installed))
          throw new Error("fresh_baseline_schema_mismatch_or_partial_install");
        for (const table of model
          .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
          .all()) {
          const query = `SELECT * FROM "${table.name.replaceAll('"', '""')}"`;
          const expected = model.prepare(query).all();
          const actual = (await sql("destination", query))[0].results;
          if (!isDeepStrictEqual(JSON.parse(JSON.stringify(expected)), actual))
            throw new Error(`fresh_baseline_seed_mismatch:${table.name}`);
        }
        const checks = await sql("destination", "PRAGMA integrity_check; PRAGMA foreign_key_check;");
        if (
          checks[0].results.length !== 1 ||
          checks[0].results[0].integrity_check !== "ok" ||
          checks[1].results.length !== 0
        )
          throw new Error("fresh_baseline_integrity_failed");
        return { baseline_sha256: fresh.baseline_sha256, migration_level: 1, integrity: "ok", foreign_keys: "ok" };
      } finally {
        model.close();
      }
    },
    transfer: (source) => sql("destination", transferSql(environment, source)),
    advance: (role, from, evidence) => sql(role, phaseSql(environment, role, from, evidence)),
    async uploadAndVerify() {
      const result = [];
      for (const [worker, path, suffix] of workerConfigurations) {
        const env = versionEnvironment(worker, path, suffix);
        try {
          result.push(await verifyUploadedVersion(env));
        } catch (error) {
          if (!error.message.startsWith("release_version_not_found:")) throw error;
          await command([
            "versions",
            "upload",
            "--strict",
            "--config",
            path,
            "--tag",
            env.RELEASE_VERSION_TAG,
            "--message",
            `${plan.release_id} ${environment.EXPECTED_HEAD_SHA}`,
          ]);
          result.push(await verifyUploadedVersion(env));
        }
      }
      return result;
    },
    async activate(versions) {
      await sql("source", renewHandoffSql(environment, "source"));
      await sql("destination", renewHandoffSql(environment, "destination"));
      for (const [index, [worker, path, suffix]] of workerConfigurations.entries()) {
        const actual = await verifyUploadedVersion(versionEnvironment(worker, path, suffix));
        if (!isDeepStrictEqual(actual, versions[index])) throw new Error("fresh_baseline_uploaded_version_changed");
      }
      for (const [index, [, path]] of workerConfigurations.entries())
        await command(["versions", "deploy", `${versions[index].version_id}@100%`, "--yes", "--config", path]);
      for (const [, path] of workerConfigurations) await command(["triggers", "deploy", "--config", path]);
    },
    async observe(versions) {
      const bindings = await observeCatalogueBindings({
        ...environment,
        REPLACEMENT_DATABASE_ID: fresh.destination_database_id,
        RETAINED_DATABASE_ID: plan.production_target.d1_databases[0].id,
      });
      const activation = await observeReleaseActivation(environment, versions, [apiConfig, configs.destination]);
      return { bindings, activation };
    },
    async smoke() {
      const config = await readWorkerConfig(configs.destination);
      return runBootstrapSmoke({
        apiUrl: environment.API_BASE_URL,
        apiKey: environment.API_TRAFFIC_TOKEN,
        ingestionUrl: config.vars.PUBLIC_BASE_URL,
        currentRevisionId: "catrev_spine_000",
      });
    },
    accept: (source) => sql("destination", destinationReleaseSql(environment, source)),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const directory = process.argv[2] ?? "/tmp/production-release";
  const run =
    process.env.HANDOFF_OPERATION === "cancel_fresh_baseline_handoff"
      ? cancelFreshBaselineRelease
      : process.env.HANDOFF_OPERATION === "correct_fresh_baseline_handoff"
        ? runFreshBaselineCorrection
        : runFreshBaselineRelease;
  const result = await run(process.env, await providerAdapter(process.env, directory));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
