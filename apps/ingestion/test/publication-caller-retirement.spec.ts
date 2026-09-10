import { expect, test } from "vitest";
import {
  seedNativePredecessor,
  approveNativeCandidate as approveControlledNativeCandidate,
  prepareNativeCandidate as prepareControlledNativeCandidate,
  approveNativeCandidateThroughBinding as approveNativeCandidate,
  prepareNativeCandidateThroughBinding as prepareNativeCandidate,
} from "./native-publication-helpers";
import {
  collect,
  get,
  installReconciliationSuite,
  post,
  postWithControlledPublication,
  testEnv,
} from "./reconciliation-helpers";

import { waitForDispatchedNativeCandidates, waitForNativeCandidate } from "./native-candidate-helpers";
import { nativeNoChangeState } from "./query-helpers/native-no-change";

const workflowIsolation = installReconciliationSuite();

test("a collected source publishes through exact native owner operations after run approval is retired", async () => {
  const collection = await collect("/reconciliation/base", "retired-callers-native-source");
  const rejected = await post(`/v1/ingestion-runs/${collection.id}/approval`, {
    candidate_digest: "a".repeat(64),
    expected_current_revision_id: "catrev_spine_000",
    idempotency_key: "retired-callers-old-intent",
  });
  expect(rejected.response.status).toBe(410);
  expect(rejected.document.code).toBe("run_approval_retired");
  const candidate = await prepareNativeCandidate(
    collection.id,
    "one-piece",
    "catrev_spine_000",
    "retired-callers-native-candidate",
  );
  const intent = {
    candidate_id: candidate.id,
    manifest_digest: candidate.manifest_digest,
    expected_game_revision_id: candidate.expected_game_revision_id,
    generation: candidate.generation,
    idempotency_key: "retired-callers-native-approval",
  };
  const rewrite = await post("/v1/publications", { ...intent, deadline: "2999-01-01T00:00:00.000Z" });
  expect(rewrite.response.status).toBe(422);
  expect(rewrite.document.code).toBe("invalid_parameter");
  for (const [patch, code] of [
    [{ manifest_digest: "0".repeat(64) }, "candidate_pin_mismatch"],
    [{ expected_game_revision_id: "catrev_stale" }, "game_revision_mismatch"],
    [{ generation: Number(candidate.generation) + 1 }, "publication_approval_conflict"],
  ] as const) {
    const invalid = await post("/v1/publications", { ...intent, ...patch, idempotency_key: `invalid-${code}` });
    expect(invalid.response.status).toBe(409);
    expect(invalid.document.code).toBe(code);
    expect((await get(`/v1/game-candidates/${candidate.id}`)).document).toEqual(candidate);
  }
  // Concurrent exact owner approvals retain one original pending acknowledgement.
  // The explicit start performed by the helper then dispatches this same intent.
  const acknowledgements = await Promise.all([post("/v1/publications", intent), post("/v1/publications", intent)]);
  expect(acknowledgements.map(({ response }) => response.status)).toEqual([202, 202]);
  expect(acknowledgements[0]!.document).toEqual(acknowledgements[1]!.document);
  expect(acknowledgements[0]!.document).toMatchObject({ state: "approved", candidate_id: candidate.id });
  const result = await approveNativeCandidate(candidate, "retired-callers-native-approval");
  expect(result.document).toMatchObject({
    state: "published",
    candidate_id: candidate.id,
    manifest_digest: candidate.manifest_digest,
    expected_game_revision_id: candidate.expected_game_revision_id,
    approval_scope: "whole_candidate",
  });
  const replay = await post("/v1/publications/start", {
    candidate_id: candidate.id,
    manifest_digest: candidate.manifest_digest,
    expected_game_revision_id: candidate.expected_game_revision_id,
    generation: candidate.generation,
    idempotency_key: "retired-callers-native-approval",
  });
  expect(replay.response.status).toBe(202);
  expect(replay.document).toEqual(acknowledgements[0]!.document);
  expect(replay.document).toMatchObject({ id: result.document.id, state: "approved", candidate_id: candidate.id });
  expect((await get(`/v1/publications/${result.document.id}`)).document).toEqual(result.document);
  const changed = await post("/v1/publications/start", {
    candidate_id: candidate.id,
    manifest_digest: "0".repeat(64),
    expected_game_revision_id: candidate.expected_game_revision_id,
    generation: candidate.generation,
    idempotency_key: "retired-callers-native-approval",
  });
  expect(changed.response.status).toBe(409);
  expect(changed.document.code).toBe("idempotency_conflict");
});

test.each(["binding", "controlled"] as const)(
  "a repeated native publication through %s execution retains unchanged source evidence and obtains the required checkpoint",
  async (execution) => {
    const publish = execution === "controlled" ? approveControlledNativeCandidate : approveNativeCandidate;
    const prepare = execution === "controlled" ? prepareControlledNativeCandidate : prepareNativeCandidate;
    const before = await workflowIsolation.instanceCounts();
    const collection = await collect("/reconciliation/base", `retired-callers-repeat-source-${execution}`);
    const first = await prepare(collection.id, "one-piece", "catrev_spine_000", `native-repeat-first-${execution}`);
    const evidence = (await get(`/v1/ingestion-runs/${collection.id}/evidence`)).document;
    const published = await publish(first, `native-repeat-first-publication-${execution}`);
    const revision = String(published.document.resulting_revision_id);
    const repeated = await prepare(collection.id, "one-piece", revision, `native-repeat-second-${execution}`);
    const next = await publish(repeated, `native-repeat-second-publication-${execution}`);
    expect(next.document).toMatchObject({ state: "published", expected_game_revision_id: revision });
    expect(next.document.resulting_revision_id).toBe(revision);
    expect(next.document.backup_attempt_id).not.toBe(published.document.backup_attempt_id);
    const retained = (await get(`/v1/ingestion-runs/${collection.id}/evidence`)).document;
    expect(retained.snapshots).toEqual(evidence.snapshots);
    expect(retained.source_coverage).toEqual(evidence.source_coverage);
    expect((await get(`/v1/publications/${published.document.id}`)).document).toEqual(published.document);
    const fresh = await collect("/reconciliation/base", `native-after-verified-checkpoint-${execution}`);
    expect(fresh.id).not.toBe(collection.id);
    const after = await workflowIsolation.instanceCounts();
    const dispatched = {
      reconciliation: after.reconciliation - before.reconciliation,
      backup: after.backup - before.backup,
    };
    if (execution === "controlled") expect(dispatched).toEqual({ reconciliation: 0, backup: 0 });
    else {
      expect(dispatched.reconciliation).toBeGreaterThan(0);
      expect(dispatched.backup).toBeGreaterThan(0);
    }
  },
);

test.each(["base", "withdrawn"])(
  "preparation predecessor retains a pending checkpoint and blocks a %s successor publication",
  async (scenario) => {
    const before = await workflowIsolation.instanceCounts();
    const source = await collect("/reconciliation/base", "predecessor-contract");
    await expect(waitForDispatchedNativeCandidates(source.id, 1)).rejects.toThrow("has no Workflow parent");
    const first = await prepareControlledNativeCandidate(
      source.id,
      "one-piece",
      "catrev_spine_000",
      "predecessor-first",
    );
    const seed = await seedNativePredecessor(first, "predecessor-seed");
    const head = await nativeNoChangeState(testEnv.CATALOGUE_DB);
    expect(head).toMatchObject({
      accepted_candidate: seed.candidateId,
      current_revision_id: seed.revisionId,
      acceptance_operation: seed.publicationId,
    });
    const successorSource =
      scenario === "base" ? source : await collect(`/reconciliation/${scenario}`, "predecessor-successor");
    const successor = await prepareControlledNativeCandidate(
      successorSource.id,
      "one-piece",
      seed.revisionId,
      "predecessor-second",
    );
    expect(successor.id).not.toBe(first.id);
    expect(await waitForNativeCandidate(String(successor.id))).toEqual(successor);
    // A second candidate for the same run must not cause selection of the already published one.
    if (scenario === "base") expect(successor.ingestion_run_id).toBe(first.ingestion_run_id);
    const approved = await post("/v1/publications", {
      candidate_id: successor.id,
      manifest_digest: successor.manifest_digest,
      expected_game_revision_id: seed.revisionId,
      generation: successor.generation,
      idempotency_key: "predecessor-blocked-successor",
    });
    expect(approved.response.status).toBe(202);
    const artifacts = await postWithControlledPublication(
      `/v1/game-candidates/${successor.id}/publication-preparation/start`,
      {
        manifest_digest: successor.manifest_digest,
        generation: successor.generation,
        sequence: 0,
        idempotency_key: "predecessor-successor-artifacts",
      },
    );
    expect(artifacts.response.status).toBe(202);
    let publicState: unknown;
    for (let sequence = 0; sequence < 50; sequence++) {
      const result = await post(`/v1/publications/${approved.document.id}/export-preparation/advance`, {
        generation: successor.generation,
        idempotency_key: `predecessor-public-${sequence}`,
      });
      expect(result.response.status, JSON.stringify(result.document)).toBe(200);
      publicState = result.document.state;
      if (publicState !== "preparing") break;
    }
    expect(publicState).toBe("verified");
    const advanced = await post(`/v1/publications/${approved.document.id}/advance`, {
      generation: successor.generation,
    });
    expect(advanced.document.state, JSON.stringify(advanced.document)).toBe("waiting_backup");
    expect(await nativeNoChangeState(testEnv.CATALOGUE_DB)).toEqual(head);
    const backup = await get(`/v1/backups/${seed.backupAttemptId}`);
    expect(backup.document).toMatchObject({ state: "pending", manifest_sha256: null, d1_bookmark: null });
    const after = await workflowIsolation.instanceCounts();
    expect(after).toEqual(before);
  },
);
