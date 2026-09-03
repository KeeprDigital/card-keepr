import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { finalizeEvidenceRun } from "../../../src/catalogue/source-evidence-repository";
import {
  createCollection,
  installRuntimeSuite,
  resumeCollection,
  showCollection,
} from "./runtime-helpers";

installRuntimeSuite();

// A superseded parent Workflow Attempt can wake from its barrier sleep after
// the run resumed and completed under a later attempt, and finalize the
// collection a second time. The retained completion facts must not move.
test("finalizing an already completed collection again leaves its completion time unchanged", async () => {
  const run = await createCollection(
    "finalization_idempotent_001",
    "https://official-source.invalid/cards",
  );
  const completed = await resumeCollection(run.id, 20_000);
  expect(completed.state).toBe("parsing");
  expect(completed.collection_completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/u);

  await new Promise((resolve) => setTimeout(resolve, 5));
  await finalizeEvidenceRun(env.CATALOGUE_DB, run.id);

  const again = await showCollection(run.id);
  expect(again.collection_completed_at).toBe(completed.collection_completed_at);
  expect(again.collection?.collection_completed_at)
    .toBe(completed.collection?.collection_completed_at);
});
