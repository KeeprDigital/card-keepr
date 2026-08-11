import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  runCli,
  startWorker,
  stopWorker,
  waitForResponse,
  waitForRunState,
} from "./helpers/acceptance-runtime.mjs";

const root = resolve(import.meta.dirname, "..");
const failureCases = [
  {
    name: "a missing required Official Source surface",
    path: "/raw-one-piece-failure-missing-surface",
    failure: "omission",
  },
  {
    name: "an Official Source result cap",
    path: "/raw-one-piece-failure-result-cap",
    failure: "cap",
  },
  {
    name: "unfinished Official Source pagination",
    path: "/raw-one-piece-failure-pagination",
    failure: "pagination",
  },
  {
    name: "invalid One Piece type-specific nullability",
    path: "/raw-one-piece-failure-nullability",
    failure: "nullability",
  },
];

for (const failureCase of failureCases) {
  test(`the CLI-to-Worker boundary fails closed for ${failureCase.name}`, async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "card-keepr-official-failure-"),
    );
    const administrationKey = crypto.randomUUID();
    const ingestionEnv = join(directory, "ingestion.env");
    const ingestionConfig = join(directory, "ingestion.wrangler.json");
    const planPath = join(directory, "source-plan.json");
    const ingestionState = join(directory, "ingestion-state");
    await writeFile(
      ingestionEnv,
      `ADMINISTRATION_KEY=${administrationKey}\n`,
      { mode: 0o600 },
    );
    const config = JSON.parse(
      readFileSync(
        resolve(root, "apps/ingestion/wrangler.jsonc"),
        "utf8",
      ),
    );
    delete config.$schema;
    config.main = resolve(root, "apps/ingestion/src/index.ts");
    config.d1_databases[0].migrations_dir = resolve(root, "migrations");
    config.services = [
      {
        binding: "OFFICIAL_SOURCE_TRANSPORT",
        service: "card-keepr-synthetic-official-source",
      },
    ];
    await writeFile(ingestionConfig, JSON.stringify(config));
    const requests = exactOnePieceRequests();
    if (failureCase.failure === "omission") {
      requests.pop();
    } else {
      requests[0].headers = {
        "user-agent":
          `card-keepr-acceptance-parser/${failureCase.failure}`,
      };
    }
    await writeFile(
      planPath,
      JSON.stringify({
        plans: [{
          supported_game: "one-piece",
          source_lineage: "one-piece-en",
          adapter_version: "one-piece-en@5",
          requests,
        }],
      }),
    );

    const source = await startWorker({
      config: "acceptance/fixtures/synthetic-official-source.wrangler.jsonc",
      statePath: join(directory, "source-state"),
    });
    const ingestion = await startWorker({
      config: ingestionConfig,
      envFile: ingestionEnv,
      migrate: true,
      statePath: ingestionState,
    });
    t.after(async () => {
      await Promise.all([stopWorker(source), stopWorker(ingestion)]);
      await rm(directory, { recursive: true, force: true });
    });
    await Promise.all([
      waitForResponse(
        `${source.url}${failureCase.path}`,
        source,
        "synthetic Official Source",
      ),
      waitForResponse(
        `${ingestion.url}/health`,
        ingestion,
        "ingestion Worker",
        { authorization: `Bearer ${administrationKey}` },
      ),
    ]);

    const cliEnvironment = {
      KEEPR_ADMINISTRATION_KEY: administrationKey,
      KEEPR_INGESTION_URL: ingestion.url,
    };
    const collected = await runCli(
      [
        "source",
        "collect",
        "--plan-file",
        planPath,
        "--idempotency-key",
        `official-failure-${failureCase.failure}`,
        "--json",
      ],
      cliEnvironment,
    );
    if (failureCase.failure === "omission") {
      assert.notEqual(collected.code, 0);
      assert.deepEqual(JSON.parse(collected.stdout), {
        contract: "card-keepr-cli-problem@1",
        status: "error",
        code: "invalid_parameter",
        detail:
          "requests must contain between 1 and 100 Official Source requests.",
      });
      return;
    }
    assert.equal(
      collected.code,
      0,
      `${collected.stdout}\n${collected.stderr}\n${ingestion.getOutput()}`,
    );
    const run = JSON.parse(collected.stdout);
    const resumed = await runCli(
      ["source", "resume", "--run-id", run.id, "--json"],
      cliEnvironment,
    );
    assert.equal(
      resumed.code,
      0,
      `${resumed.stdout}\n${resumed.stderr}\n${ingestion.getOutput()}`,
    );

    const failed = await waitForRunState(
      run.id,
      "failed",
      cliEnvironment,
      ingestion,
      { deadlineMs: 90_000 },
    );
    assert.equal(failed.failure_code, "source_parse_failed");
    const snapshotUrls = failed.snapshots.map(({ request }) => request.url);
    assert.ok(snapshotUrls.length >= 2);
    assert.ok(snapshotUrls.every((url) =>
      new URL(url).origin === "https://en.onepiece-cardgame.com"
    ));
    assert.ok(snapshotUrls.filter((url) =>
      url === "https://en.onepiece-cardgame.com/cardlist/?series=569116"
    ).length >= 2);
    assert.equal(
      failed.observation_sets.length,
      failed.snapshots.length - 1,
      `every successfully parsed root, stage, and final snapshot retains one observation set; missing: ${
        JSON.stringify(failed.snapshots.filter(({ id }) =>
          !failed.observation_sets.some(
            ({ source_snapshot_id }) => source_snapshot_id === id,
          )
        ).map(({ request }) => request.url))
      }`,
    );
  });
}

function exactOnePieceRequests() {
  return [{
    id: "one-piece-en:discovery",
    url: "https://en.onepiece-cardgame.com/cardlist/?series=569116",
  }];
}
