import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("the repository CLI reports retained Official Source evidence", async (t) => {
  const administrationKey = randomUUID();
  const collection = {
    id: "run_source_cli_001",
    state: "parsing",
    snapshots: [{ id: "srcsnap_cli_001" }],
    observation_sets: [{ id: "srcobsset_cli_001" }],
    diagnostics: [],
  };
  const server = createServer((request, response) => {
    assert.equal(
      request.headers.authorization,
      `Bearer ${administrationKey}`,
    );
    assert.equal(
      request.url,
      "/v1/ingestion-runs/run_source_cli_001/evidence",
    );
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(collection));
  });
  await new Promise((resolveListen) => {
    server.listen(0, "127.0.0.1", resolveListen);
  });
  t.after(
    () =>
      new Promise((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) rejectClose(error);
          else resolveClose();
        });
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test administration server did not bind");
  }

  const result = await runCli(
    ["source", "show", "--run-id", collection.id],
    {
      KEEPR_ADMINISTRATION_KEY: administrationKey,
      KEEPR_INGESTION_URL: `http://127.0.0.1:${address.port}`,
    },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(
    result.stdout,
    "Ingestion Run run_source_cli_001 evidence: parsing; 1 Source Snapshot; 1 Source Observation set; 0 diagnostics\n",
  );
});

function runCli(arguments_, environment) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      process.execPath,
      [resolve(root, "cli/keepr.mjs"), ...arguments_],
      {
        cwd: root,
        env: { ...process.env, ...environment },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", rejectRun);
    child.once("exit", (code) => {
      resolveRun({ code, stdout, stderr });
    });
  });
}
