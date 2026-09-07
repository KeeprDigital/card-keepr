import { installLegacyCurrentHead, restoreFixtureSpine } from "./query-helpers/atomic-publication";
import { admitSyntheticCurrentCheckpoint, currentGameMembers } from "./query-helpers/atomic-publication";
import { rejectedAtomicSwitch, publicationStateSnapshot } from "./query-helpers/atomic-publication";
import { expect, test } from "vitest";
import { collect, get, post, installReconciliationSuite, requiredString, testEnv } from "./reconciliation-helpers";

installReconciliationSuite();

// Synthetic retained source evidence; exercises authenticated owner operations.
test("exact whole-candidate approval is durable before acknowledgement and a lost response reuses its operation", async () => {
  const source = await collect("/reconciliation/base", "atomic-source");
  const created = await post("/v1/game-candidates", {
    ingestion_run_id: source.id,
    supported_game: "one-piece",
    expected_game_revision_id: "catrev_spine_000",
    idempotency_key: "atomic-candidate",
  });
  const id = requiredString(created.document, "id");
  let candidate = created.document;
  const deadline = Date.now() + 15000;
  while (candidate.state === "preparing" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    candidate = (await get(`/v1/game-candidates/${id}`)).document;
  }
  expect(candidate.state).toBe("sealed");
  const intent = {
    candidate_id: id,
    manifest_digest: candidate.manifest_digest,
    expected_game_revision_id: "catrev_spine_000",
    generation: candidate.generation,
    idempotency_key: "atomic-approval",
  };
  const approved = await post("/v1/publications", intent);
  expect(approved.response.status, JSON.stringify(approved.document)).toBe(202);
  expect(approved.document).toMatchObject({
    candidate_id: id,
    deadline: candidate.deadline,
    state: "approved",
    approval_scope: "whole_candidate",
  });
  expect(approved.document.id).not.toBe(id);
  expect(approved.document.id).not.toBe(source.id);
  expect((await post("/v1/publications", intent)).document).toEqual(approved.document);
  expect((await get(`/v1/publications/${approved.document.id}`)).document).toEqual(approved.document);
  expect((await post("/v1/publications", { ...intent, manifest_digest: "0".repeat(64) })).response.status).toBe(409);
  const preparationPath = `/v1/game-candidates/${id}/publication-preparation`;
  let preparation = (
    await post(preparationPath, {
      manifest_digest: candidate.manifest_digest,
      generation: 0,
      sequence: 0,
      idempotency_key: "atomic-artifacts",
    })
  ).document;
  for (let unit = 0; preparation.state === "preparing" && unit < 250; unit++) {
    preparation = (
      await post(preparationPath, {
        manifest_digest: candidate.manifest_digest,
        generation: 0,
        sequence: preparation.sequence,
        idempotency_key: `atomic-artifacts-${unit}`,
      })
    ).document;
  }
  expect(preparation.state).toBe("verified");
  const composition = await post("/v1/publication-compositions", { candidate_ids: [id] });
  expect(composition.response.status).toBe(200);
  const switchInput = {
    id: String(approved.document.id),
    generation: 0,
    predecessor: "catrev_spine_000",
    composition: String(composition.document.root_digest),
    at: new Date().toISOString(),
    revision: "catrev_rejected_atomic",
    backup: "backup_rejected_atomic",
  };
  const before = await publicationStateSnapshot(testEnv.CATALOGUE_DB);
  for (const [change, code] of [
    [{ generation: 9 }, "publication_writer_conflict"],
    [{ clockOffsetMs: 8 * 86400000 }, "publication_deadline_expired"],
    [{ predecessor: "catrev_missing" }, "publication_composition_conflict"],
    [{ composition: "0".repeat(64) }, "publication_composition_unverified"],
  ] as const) {
    await expect(rejectedAtomicSwitch(testEnv.CATALOGUE_DB, { ...switchInput, ...change })).rejects.toThrow(code);
    expect(await publicationStateSnapshot(testEnv.CATALOGUE_DB)).toEqual(before);
    expect((await get(`/v1/publications/${approved.document.id}`)).document.state).toBe("approved");
  }
  await installLegacyCurrentHead(testEnv.CATALOGUE_DB, source.id);
  const legacyBefore = await publicationStateSnapshot(testEnv.CATALOGUE_DB);
  await expect(
    rejectedAtomicSwitch(testEnv.CATALOGUE_DB, { ...switchInput, predecessor: "catrev_legacy_guard" }),
  ).rejects.toThrow("publication_legacy_composition_unprepared");
  expect(await publicationStateSnapshot(testEnv.CATALOGUE_DB)).toEqual(legacyBefore);
  await restoreFixtureSpine(testEnv.CATALOGUE_DB);
  const switched = await post(`/v1/publications/${approved.document.id}/advance`, { generation: 0 });
  expect(switched.response.status, JSON.stringify(switched.document)).toBe(200);
  expect(switched.document).toMatchObject({
    state: "published",
    deadline: candidate.deadline,
    backup_attempt_id: expect.any(String),
    resulting_revision_id: expect.any(String),
  });
  expect((await post(`/v1/publications/${approved.document.id}/advance`, { generation: 0 })).document).toEqual(
    switched.document,
  );
  expect((await get(`/v1/game-candidates/${id}`)).document.state).toBe("published");
  const next = await post("/v1/game-candidates", {
    ingestion_run_id: source.id,
    supported_game: "one-piece",
    expected_game_revision_id: switched.document.resulting_revision_id,
    idempotency_key: "same-source-next",
  });
  let second = next.document;
  const secondDeadline = Date.now() + 15000;
  while (second.state === "preparing" && Date.now() < secondDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    second = (await get(`/v1/game-candidates/${second.id}`)).document;
  }
  expect(second.state, JSON.stringify(second)).toBe("sealed");
  expect(second.ingestion_run_id).toBe(source.id);
  expect(second.id).not.toBe(id);
  const secondApproval = await post("/v1/publications", {
    ...intent,
    candidate_id: second.id,
    manifest_digest: second.manifest_digest,
    expected_game_revision_id: switched.document.resulting_revision_id,
    idempotency_key: "same-source-next-approval",
  });
  expect(secondApproval.response.status, JSON.stringify(secondApproval.document)).toBe(202);
  const secondPath = `/v1/game-candidates/${second.id}/publication-preparation`;
  let secondPreparation = (
    await post(secondPath, {
      manifest_digest: second.manifest_digest,
      generation: 0,
      sequence: 0,
      idempotency_key: "second-artifacts",
    })
  ).document;
  for (let unit = 0; secondPreparation.state === "preparing" && unit < 250; unit++)
    secondPreparation = (
      await post(secondPath, {
        manifest_digest: second.manifest_digest,
        generation: 0,
        sequence: secondPreparation.sequence,
        idempotency_key: `second-artifacts-${unit}`,
      })
    ).document;
  expect(secondPreparation.state).toBe("verified");
  const waiting = await post(`/v1/publications/${secondApproval.document.id}/advance`, { generation: 0 });
  expect(waiting.document.state, JSON.stringify(waiting.document)).toBe("waiting_backup");
  const resumed = await post(`/v1/publications/${secondApproval.document.id}/resume`, {
    generation: 0,
    idempotency_key: "resume-exact-approval",
  });
  expect(resumed.document).toMatchObject({
    generation: 1,
    deadline: second.deadline,
    candidate_id: second.id,
    manifest_digest: second.manifest_digest,
  });
  expect(
    (await post(`/v1/publications/${secondApproval.document.id}/advance`, { generation: 0 })).response.status,
  ).toBe(409);
  const replay = await post(`/v1/publications/${secondApproval.document.id}/resume`, {
    generation: 0,
    idempotency_key: "resume-exact-approval",
  });
  expect(replay.document).toEqual(resumed.document);
  expect((await get(`/v1/publications/${approved.document.id}`)).document.resulting_revision_id).toBe(
    switched.document.resulting_revision_id,
  );
  const otherSource = await collect("/reconciliation/profile-fusion-world", "atomic-fusion-source", {
    game: "fusion-world",
    lineage: "fusion-world-en",
    adapter: "fixture-fusion-world-json@2",
  });
  let other = (
    await post("/v1/game-candidates", {
      ingestion_run_id: otherSource.id,
      supported_game: "fusion-world",
      expected_game_revision_id: "catrev_spine_000",
      idempotency_key: "atomic-fusion-candidate",
    })
  ).document;
  const otherDeadline = Date.now() + 15000;
  while (other.state === "preparing" && Date.now() < otherDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    other = (await get(`/v1/game-candidates/${other.id}`)).document;
  }
  expect(other.state, JSON.stringify(other)).toBe("sealed");
  const otherApproval = await post("/v1/publications", {
    candidate_id: other.id,
    manifest_digest: other.manifest_digest,
    expected_game_revision_id: "catrev_spine_000",
    generation: other.generation,
    idempotency_key: "atomic-fusion-approval",
  });
  expect(otherApproval.response.status).toBe(202);
  const otherPath = `/v1/game-candidates/${other.id}/publication-preparation`;
  let otherPrepared = (
    await post(otherPath, {
      manifest_digest: other.manifest_digest,
      generation: 0,
      sequence: 0,
      idempotency_key: "other-artifacts",
    })
  ).document;
  for (let unit = 0; otherPrepared.state === "preparing" && unit < 250; unit++)
    otherPrepared = (
      await post(otherPath, {
        manifest_digest: other.manifest_digest,
        generation: 0,
        sequence: otherPrepared.sequence,
        idempotency_key: `other-artifacts-${unit}`,
      })
    ).document;
  expect(otherPrepared.state).toBe("verified");
  expect((await post(`/v1/publications/${otherApproval.document.id}/advance`, { generation: 0 })).document.state).toBe(
    "waiting_backup",
  );
  const initialMembers = (await currentGameMembers(testEnv.CATALOGUE_DB)).results;
  await admitSyntheticCurrentCheckpoint(testEnv.CATALOGUE_DB);
  await Promise.all([
    post(`/v1/publications/${secondApproval.document.id}/advance`, { generation: 1 }),
    post(`/v1/publications/${otherApproval.document.id}/advance`, { generation: 0 }),
  ]);
  await admitSyntheticCurrentCheckpoint(testEnv.CATALOGUE_DB);
  for (const [operation, generation] of [
    [secondApproval.document.id, 1],
    [otherApproval.document.id, 0],
  ] as const) {
    const result = await post(`/v1/publications/${operation}/advance`, { generation });
    expect(result.document.state, JSON.stringify(result.document)).toBe("published");
  }
  const members = (await currentGameMembers(testEnv.CATALOGUE_DB)).results;
  expect(members).toHaveLength(2);
  expect(members.find((member) => member.supported_game === "one-piece")).toMatchObject({
    candidate_id: second.id,
    card_ids: initialMembers[0]!.card_ids,
  });
  expect(members.find((member) => member.supported_game === "fusion-world")).toMatchObject({ candidate_id: other.id });
  expect((await get(`/v1/publications/${otherApproval.document.id}`)).document.deadline).toBe(other.deadline);
});
