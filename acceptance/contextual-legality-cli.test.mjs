import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("CLI requests one explicit contextual Legality Status", async (t) => {
  const requests = [];
  const document = {
    data: [
      {
        card_id: "card_gundam_st01_001",
        on: "2026-07-30",
        format: "standard",
        event_tier: "championship",
        region: "EN-ASIA",
        status: "restricted",
        rule_ids: ["legality_rule_asia_copy_limit"],
        derivation:
          "Restricted to one copy by legality_rule_asia_copy_limit.",
      },
    ],
    meta: {
      catalogue_revision_id: "catrev_legality_demo",
      published_at: "2026-07-30T00:00:00.000Z",
    },
    links: {
      self:
        "/v1/legality-status?card_id=card_gundam_st01_001&on=2026-07-30&format=standard&event_tier=championship&region=EN-ASIA",
    },
  };
  const server = createServer((request, response) => {
    requests.push({
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization,
    });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(document));
  });
  await new Promise((resolveListen) =>
    server.listen(0, "127.0.0.1", resolveListen),
  );
  t.after(
    () =>
      new Promise((resolveClose) => server.close(resolveClose)),
  );
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");

  const result = await runCli(
    [
      "legality",
      "status",
      "--card-id",
      "card_gundam_st01_001",
      "--on",
      "2026-07-30",
      "--format",
      "standard",
      "--event-tier",
      "championship",
      "--region",
      "EN-ASIA",
      "--json",
    ],
    {
      KEEPR_API_URL: `http://127.0.0.1:${address.port}`,
      KEEPR_API_KEY: "cli-api-key",
    },
  );

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), document);
  assert.deepEqual(requests, [
    {
      method: "GET",
      path:
        "/v1/legality-status?card_id=card_gundam_st01_001&on=2026-07-30&format=standard&event_tier=championship&region=EN-ASIA",
      authorization: "Bearer cli-api-key",
    },
  ]);
});

function runCli(arguments_, environment) {
  return new Promise((resolveExit) => {
    const child = spawn(
      process.execPath,
      [resolve(root, "cli/keepr.mjs"), ...arguments_],
      {
        cwd: root,
        env: {
          ...process.env,
          ...environment,
        },
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
    child.once("exit", (code) => {
      resolveExit({ code, stdout, stderr });
    });
  });
}
