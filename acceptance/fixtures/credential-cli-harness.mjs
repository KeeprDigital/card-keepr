import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { main } from "../../cli/keepr.mjs";

const server = createServer(async (request, response) => {
  if (
    request.method !== "POST" ||
    request.url !== "/credential-boundary"
  ) {
    response.writeHead(404).end();
    return;
  }
  let input = "";
  for await (const chunk of request) input += chunk;
  const { plan, secrets } = JSON.parse(input);
  if (process.env.KEEPR_TEST_BOUNDARY_LOG) {
      appendFileSync(
        process.env.KEEPR_TEST_BOUNDARY_LOG,
        `${JSON.stringify({
          action: plan.action,
          plan_id: plan.id,
          secret_fields: Object.keys(secrets).sort(),
        })}\n`,
      );
  }
  if (process.env.KEEPR_TEST_BOUNDARY_FAIL === "1") {
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({
        ok: false,
        journal: {
          contract: "card-keepr-provider-mutation-journal@1",
          mutation_started: false,
          steps: [],
        },
      }));
    return;
  }
  if (process.env.KEEPR_TEST_BOUNDARY_FAIL === "after-mutation") {
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({
        ok: false,
        journal: {
          contract: "card-keepr-provider-mutation-journal@1",
          mutation_started: true,
          steps: ["consumer-secret-put:test-slot"],
        },
      }));
    return;
  }
  response
    .writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify({
      ok: true,
      plan_id: plan.id,
      plan_digest: plan.plan_digest,
      boundary_attestation:
        "test-only-injected-boundary-attestation-without-production-key",
    }));
});
await new Promise((resolve) => {
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
const environment = {
  ...process.env,
  NODE_ENV: "test",
  KEEPR_TEST_BOUNDARY_URL:
    `http://127.0.0.1:${address.port}/credential-boundary`,
};
const code = await main(process.argv.slice(2), environment);
await new Promise((resolve, reject) => {
  server.close((error) => error === undefined ? resolve() : reject(error));
});
process.exitCode = code;
