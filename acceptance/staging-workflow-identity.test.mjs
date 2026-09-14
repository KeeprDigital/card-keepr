import assert from "node:assert/strict";
import test from "node:test";
import { stagingWorkflowFixture } from "./helpers/staging-workflow.mjs";

test("signed manual staging identity preserves an older selected commit across later main merges", async (t) => {
  const { verifyStagingWorkflow } = await import("../src/http/dev-workflow-identity.mjs");
  const { selected, main, now, token, state } = await stagingWorkflowFixture(t);
  const intent = { head_sha: selected, ci_run_id: "123", expected_actor: "owner" };
  assert.equal((await verifyStagingWorkflow(await token(), "synthetic-github-token", intent)).headSha, selected);
  state.ciEvent = "workflow_dispatch";
  assert.equal((await verifyStagingWorkflow(await token(), "synthetic-github-token", intent)).headSha, selected);
  for (const change of [{ event_name: "workflow_run" }, { environment: "dev" }, { actor: "other" }, { exp: now - 1 }])
    await assert.rejects(verifyStagingWorkflow(await token(change), "synthetic-github-token", intent));
  await assert.rejects(verifyStagingWorkflow(await token(), "synthetic-github-token", { ...intent, head_sha: main }));
  state.checkConclusion = "failure";
  await assert.rejects(verifyStagingWorkflow(await token(), "synthetic-github-token", intent));
});
