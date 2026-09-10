import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { runCli, startWorker, stopWorker, waitForHealth } from "./helpers/acceptance-runtime.mjs";
import {
  inspectNativeCollection,
  nativeCheckpointTransport,
  publishNativeCollection,
  waitForNativeCollection,
} from "./helpers/native-catalogue-runtime.mjs";
import { syntheticSourceAdapterMigrations } from "./helpers/synthetic-source-adapters.mjs";

// Synthetic two-presentation proof. Neither fixture represents a live Limitless
// adapter, cross-source identity matching, complete source coverage or recovery.
for (const presentation of ["nested", "tabular"]) {
  test(`owner publishes ${presentation} source presentation through shared One Piece semantics`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), `keepr-profiles-${presentation}-`));
    const root = resolve(import.meta.dirname, "..");
    const statePath = join(directory, "state");
    const ingestionEnv = join(directory, "ingestion.env");
    const apiEnv = join(directory, "api.env");
    const key = crypto.randomUUID();
    await writeFile(ingestionEnv, `ADMINISTRATION_KEY=${key}\nADMINISTRATION_CLOCK_MODE=request\n`);
    await writeFile(apiEnv, `API_BEARER_KEY=${key}\n`);
    const config = JSON.parse(await readFile(join(root, "apps/ingestion/wrangler.jsonc"), "utf8"));
    delete config.$schema;
    config.main = join(root, "acceptance/fixtures/native-retained-evidence-harness.ts");
    config.d1_databases[0].migrations_dir = join(root, "migrations");
    // This journey exercises admission/publication; the fixture budget covers its bounded inspection requests.
    config.ratelimits.find(({ name }) => name === "ADMINISTRATION_RATE_LIMIT").simple.limit = 300;
    config.services = [{ binding: "OFFICIAL_SOURCE_TRANSPORT", service: "card-keepr-synthetic-official-source" }];
    const configPath = join(directory, "ingestion.json");
    await writeFile(configPath, JSON.stringify(config));
    const source = await startWorker({
      config: "acceptance/fixtures/synthetic-official-source.wrangler.jsonc",
      statePath: join(directory, "source"),
    });
    const checkpointTransport = await nativeCheckpointTransport(t, statePath, directory, configPath);
    const ingestion = await startWorker({
      ...checkpointTransport,
      config: configPath,
      envFile: ingestionEnv,
      statePath,
      migrate: true,
      testMigrations: await syntheticSourceAdapterMigrations(),
    });
    let api;
    t.after(async () => {
      await Promise.all([stopWorker(source), stopWorker(ingestion), ...(api ? [stopWorker(api)] : [])]);
      await rm(directory, { recursive: true, force: true });
    });
    await waitForHealth(`${ingestion.url}/health`, key, ingestion);
    const environment = {
      KEEPR_INGESTION_URL: ingestion.url,
      KEEPR_ADMINISTRATION_KEY: key,
      KEEPR_NATIVE_REQUEST_INTERVAL_MS: "250",
    };
    const cli = async (args) => {
      const result = await runCli([...args, "--json"], environment);
      assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
      return JSON.parse(result.stdout);
    };
    const collectNativeSource = async (lineage, adapter, url, key) => {
      const path = join(directory, `${key}-source-plan.json`);
      await writeFile(
        path,
        JSON.stringify({
          plans: [
            {
              supported_game: "one-piece",
              source_lineage: lineage,
              adapter_version: adapter,
              requests: [{ id: `${lineage}:discovery`, url }],
            },
          ],
        }),
      );
      const run = await cli(["source", "collect", "--plan-file", path, "--idempotency-key", key]);
      assert.equal(run.state, "parsing");
      const prepared = await fetch(`${ingestion.url}/v1/game-candidates`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${environment.KEEPR_ADMINISTRATION_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ingestion_run_id: run.id,
          supported_game: "one-piece",
          expected_game_revision_id: "catrev_spine_000",
          idempotency_key: `${key}-candidate`,
        }),
      });
      assert.equal(prepared.status, 201, await prepared.clone().text());
      return run;
    };

    const registry = await cli(["source", "registry"]);
    assert.ok(registry.profiles.some(({ id }) => id === "one-piece@1"));
    const lineage = presentation === "tabular" ? "limitless-one-piece-en" : "one-piece-en";
    if (presentation === "tabular") {
      for (const area of ["card_facts", "printing_details"]) {
        const decision = await cli([
          "source",
          "designate",
          "--game",
          "one-piece",
          "--locale",
          "en",
          "--release-region",
          "OCEANIA",
          "--area",
          area,
          "--source-lineage",
          lineage,
          "--expected-generation",
          "0",
          "--rationale",
          "Synthetic representative source proof",
          "--idempotency-key",
          area,
        ]);
        assert.equal(decision.generation, 1);
      }
    }
    // After selecting the supplemental source, publisher ownership must not
    // authorize fallback. Capture succeeds and leaves inspectable evidence;
    // reconciliation fails because the selected authority is absent.
    if (presentation === "tabular") {
      const fallback = await collectNativeSource(
        "one-piece-en",
        "fixture-one-piece-json@3",
        "https://shared-profile-source.invalid/nested",
        "fallback",
      );
      const failed = await waitForNativeCollection(fallback.id, "failed", environment, ingestion);
      assert.equal(failed.failure_code, "retained_evidence_invalid");
      const evidence = await (
        await fetch(`${ingestion.url}/v1/ingestion-runs/${fallback.id}/evidence`, {
          headers: { authorization: `Bearer ${key}` },
        })
      ).json();
      assert.ok(evidence.snapshots.length > 0);
      const policy = await cli(["source", "authorities"]);
      assert.equal(
        policy.authorities.find(({ area, game }) => area === "card_facts" && game === "one-piece").source_lineage,
        lineage,
      );
    }
    const run = await collectNativeSource(
      lineage,
      presentation === "tabular" ? "fixture-one-piece-tabular@1" : "fixture-one-piece-json@3",
      `https://shared-profile-source.invalid/${presentation}`,
      "collect",
    );
    await waitForNativeCollection(run.id, "sealed", environment, ingestion);
    const candidate = await inspectNativeCollection(run.id, environment);
    assert.ok(
      candidate.warnings.some(
        ({ code, raw_value }) => code === "unknown_source_field" && raw_value === "Retain for schema review",
      ),
    );
    const approved = await publishNativeCollection(candidate, `approve-${presentation}`, environment, ingestion);
    assert.ok(approved.resulting_revision_id);
    await stopWorker(ingestion);
    api = await startWorker({ config: "apps/api/wrangler.jsonc", envFile: apiEnv, statePath });
    await waitForHealth(`${api.url}/health`, key, api);
    const response = await fetch(`${api.url}/v1/cards?game=one-piece`, { headers: { authorization: `Bearer ${key}` } });
    assert.equal(response.status, 200);
    const cards = await response.json();
    assert.equal(cards.data.length, 1);
    const detail = await (
      await fetch(`${api.url}/v1/cards/${cards.data[0].id}`, { headers: { authorization: `Bearer ${key}` } })
    ).json();
    assert.equal(detail.data.game_data.profile, "one-piece@1");
    assert.equal(detail.data.game_data.attributes.life, 5);
    assert.equal(detail.data.game_data.attributes.power, 5000);
    assert.equal(detail.data.game_data.attributes.future_mechanic, undefined);
    assert.equal(detail.data.name, "Monkey.D.Luffy");
  });
}
