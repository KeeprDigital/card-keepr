import { env } from "cloudflare:test";
import { expect, test } from "vitest";
import ingestionWorker from "../src/index";
import { assertHttpResponse } from "../../../test/support/http-contract";
import contract from "../../../contracts/admin-openapi.json";

test("signed deployment operations document their environment rejection before owner authentication", async () => {
  for (const [path, environment] of [
    ["/v1/dev-deployments", "production"],
    ["/v1/staging-release-authorizations", "dev"],
    ["/v1/staging-deployments", "production"],
    ["/v1/staging-deployments/{release}/outcome", "production"],
    ["/v1/staging-deployments/{release}/promotion-outcome", "production"],
    ["/v1/production-promotions", "staging"],
  ] as const) {
    const response = await ingestionWorker.fetch(
      new Request(`https://alternate.invalid${path!.replace("{release}", "staging-test")}`, {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      }),
      deploymentEnvironment(environment),
    );
    expect(response.status).toBe(404);
    await assertHttpResponse(contract, path!, "post", response);
  }
});

test("dev deployment keeps signed credentials separate and bounds JSON without changing media decoding", async () => {
  for (const [body, key, status] of [
    ['{"head_sha":"' + "a".repeat(40) + '","ci_run_id":"42"}', "vitest-administration-key", 403],
    ['{"head_sha":"' + "a".repeat(40) + '","ci_run_id":"42"}', "vitest-api-key", 403],
    ["{", "vitest-administration-key", 400],
    [JSON.stringify({ padding: "x".repeat(16_384) }), "vitest-administration-key", 413],
  ] as const) {
    const response = await ingestionWorker.fetch(
      new Request("https://alternate.invalid/v1/dev-deployments", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "text/plain" },
        body,
      }),
      deploymentEnvironment("dev"),
    );
    expect(response.status).toBe(status);
    await assertHttpResponse(contract, "/v1/dev-deployments", "post", response);
  }
});

function deploymentEnvironment(environment: string): Env {
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === "KEEPR_ENVIRONMENT") return environment;
      return Reflect.get(target, property, receiver);
    },
  });
}
