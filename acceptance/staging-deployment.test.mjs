import assert from "node:assert/strict";
import test from "node:test";

test("isolated staging executor refuses commit substitution before provider access", async (t) => {
  const { deployEnvironment } = await import("../scripts/deploy-dev.mjs");
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = () => assert.fail("A changed checkout must not reach any provider");
  await assert.rejects(
    deployEnvironment({ RELEASE_ENVIRONMENT: "staging", EXPECTED_HEAD_SHA: "a".repeat(40) }, async (command, args) => {
      assert.equal(command, "git");
      assert.deepEqual(args, ["rev-parse", "HEAD"]);
      return { stdout: "b".repeat(40) };
    }),
    /staging_checkout_mismatch/u,
  );
  await assert.rejects(deployEnvironment({ RELEASE_ENVIRONMENT: "production" }), /isolated_environment_required/u);
});
