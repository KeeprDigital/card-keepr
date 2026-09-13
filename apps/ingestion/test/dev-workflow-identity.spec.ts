import { expect, test } from "vitest";
import { verifyDevCommit } from "../../../src/http/dev-workflow-identity.mjs";

test("dev exact-commit verification uses the Worker HTTP transport", async () => {
  const headSha = "a".repeat(40);
  await expect(verifyDevCommit("synthetic-dev-github-token", { head_sha: headSha, ci_run_id: "123" })).resolves.toBe(
    headSha,
  );
});

test("dev verification refuses a provider redirect even to a passing CI run", async () => {
  await expect(
    verifyDevCommit("synthetic-dev-github-token", { head_sha: "a".repeat(40), ci_run_id: "124" }),
  ).rejects.toThrow("invalid_dev_workflow_attestation");
});
