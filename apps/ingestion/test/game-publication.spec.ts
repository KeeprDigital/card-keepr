import { catalogueStore } from "../../../src/catalogue/shared";
import { advancePublicationExports } from "../../../src/catalogue/ingestion";
import { prepareCatalogueExportDeletion, confirmCatalogueExportDeletion } from "../../../src/catalogue/export";
import { publicComponents } from "./query-helpers/atomic-publication";
import { compositionEntityResponse } from "../../../src/catalogue/read/composition-read";
import {
  compositionExportResponse,
  compositionExportComponentResponse,
} from "../../../src/catalogue/read/composition-export";
import { installLegacyCurrentHead, restoreFixtureSpine } from "./query-helpers/atomic-publication";
import { admitSyntheticCurrentCheckpoint, currentGameMembers } from "./query-helpers/atomic-publication";
import { rejectedAtomicSwitch, publicationStateSnapshot } from "./query-helpers/atomic-publication";
import { expect, test } from "vitest";
import { collect, get, post, installReconciliationSuite, requiredString, testEnv } from "./reconciliation-helpers";

installReconciliationSuite();

// Synthetic retained source evidence; exercises authenticated owner operations.
test.each(["contention", "backup-wait expiry"])("whole-candidate approval and %s", async (scenario) => {
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
  const beforePublic = await publicationStateSnapshot(testEnv.CATALOGUE_DB);
  expect((await post(`/v1/publications/${approved.document.id}/advance`, { generation: 0 })).document.state).toBe(
    "waiting_artifacts",
  );
  expect(await publicationStateSnapshot(testEnv.CATALOGUE_DB)).toEqual(beforePublic);
  await preparePublicExports(String(approved.document.id), 0);
  const firstComponents = (await publicComponents(testEnv.CATALOGUE_DB, id)).results;
  expect(firstComponents.length).toBeGreaterThan(0);
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
    expect((await get(`/v1/publications/${approved.document.id}`)).document.state).toBe("waiting_artifacts");
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
  const consumerBase = { origin: "https://catalogue.example", basePath: "" };
  const firstCards = (await (await compositionEntityResponse(
    catalogueStore(testEnv.CATALOGUE_DB),
    new Request(`${consumerBase.origin}/v1/cards?game=one-piece`),
    consumerBase,
    "cards",
  ))!.json()) as { data: { id: string; lifecycle: unknown }[] };
  expect(firstCards.data.length).toBeGreaterThan(0);
  for (const card of firstCards.data)
    expect(card.lifecycle).toEqual({
      first_revision_id: switched.document.resulting_revision_id,
      last_observed_revision_id: switched.document.resulting_revision_id,
      withdrawn: false,
    });
  const firstExport = (await (await compositionExportResponse(
    catalogueStore(testEnv.CATALOGUE_DB),
    new Request(`${consumerBase.origin}/v1/catalogue-exports/${switched.document.resulting_revision_id}`),
    consumerBase,
    String(switched.document.resulting_revision_id),
  ))!.json()) as { data: unknown };
  const otherHost = (await (await compositionExportResponse(
    catalogueStore(testEnv.CATALOGUE_DB),
    new Request(`https://another.example/v1/catalogue-exports/${switched.document.resulting_revision_id}`),
    { origin: "https://another.example", basePath: "" },
    String(switched.document.resulting_revision_id),
  ))!.json()) as { data: unknown };
  expect(otherHost.data).toEqual(firstExport.data);
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
  const recordPuts: string[] = [];
  const reuseBucket = new Proxy(testEnv.CATALOGUE_EXPORTS, {
    get(target, property) {
      if (property === "put")
        return (...args: Parameters<R2Bucket["put"]>) => {
          if (args[0].startsWith("catalogue-public-components/")) recordPuts.push(args[0]);
          return target.put(...args);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await preparePublicExports(String(secondApproval.document.id), 0, reuseBucket);
  expect(recordPuts).toEqual([]);
  expect((await publicComponents(testEnv.CATALOGUE_DB, String(second.id))).results).toEqual(firstComponents);
  const waiting = await post(`/v1/publications/${secondApproval.document.id}/advance`, { generation: 0 });
  expect(waiting.document.state, JSON.stringify(waiting.document)).toBe("waiting_backup");
  if (scenario === "backup-wait expiry") {
    const publicState = await publicationStateSnapshot(testEnv.CATALOGUE_DB);
    const beforeDeadline = await post(
      `/v1/publications/${secondApproval.document.id}/advance`,
      { generation: 0 },
      { "x-keepr-test-now": new Date(Date.parse(String(second.deadline)) - 1).toISOString() },
    );
    expect(beforeDeadline.document.state).toBe("waiting_backup");
    const expired = await post(
      `/v1/publications/${secondApproval.document.id}/advance`,
      { generation: 0 },
      { "x-keepr-test-now": String(second.deadline) },
    );
    expect(expired.document).toMatchObject({
      state: "failed",
      failure_code: "publication_deadline_expired",
      deadline: second.deadline,
      candidate_id: second.id,
      manifest_digest: second.manifest_digest,
      resulting_revision_id: null,
      backup_attempt_id: null,
    });
    expect(await publicationStateSnapshot(testEnv.CATALOGUE_DB)).toEqual(publicState);
    expect((await post(`/v1/publications/${secondApproval.document.id}/advance`, { generation: 0 })).document).toEqual(
      expired.document,
    );
    expect(
      (
        await post(`/v1/publications/${secondApproval.document.id}/resume`, {
          generation: 0,
          idempotency_key: "cannot-resume-expired-approval",
        })
      ).response.status,
    ).toBe(409);
    expect(await publicationStateSnapshot(testEnv.CATALOGUE_DB)).toEqual(publicState);
    return;
  }
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
  await preparePublicExports(String(otherApproval.document.id), 0);
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
  expect(members.find((member) => member.supported_game === "fusion-world")).toMatchObject({
    candidate_id: other.id,
  });
  expect((await get(`/v1/publications/${otherApproval.document.id}`)).document.deadline).toBe(other.deadline);
  const carriedCards = (await (await compositionEntityResponse(
    catalogueStore(testEnv.CATALOGUE_DB),
    new Request(`${consumerBase.origin}/v1/cards?game=one-piece`),
    consumerBase,
    "cards",
  ))!.json()) as { data: { id: string; lifecycle: unknown }[] };
  expect(carriedCards.data.map((c) => ({ id: c.id, lifecycle: c.lifecycle }))).toEqual(
    firstCards.data.map((c) => ({ id: c.id, lifecycle: c.lifecycle })),
  );
  const retainedExport = (await (await compositionExportResponse(
    catalogueStore(testEnv.CATALOGUE_DB),
    new Request(`${consumerBase.origin}/v1/catalogue-exports/${switched.document.resulting_revision_id}`),
    consumerBase,
    String(switched.document.resulting_revision_id),
  ))!.json()) as { data: unknown };
  expect(retainedExport.data).toEqual(firstExport.data);
  await admitSyntheticCurrentCheckpoint(testEnv.CATALOGUE_DB);
  const current = (await publicationStateSnapshot(testEnv.CATALOGUE_DB)) as { current_revision_id: string };
  const currentRequest = new Request(`${consumerBase.origin}/v1/catalogue-exports/${current.current_revision_id}`);
  const currentBefore = (await (await compositionExportResponse(
    catalogueStore(testEnv.CATALOGUE_DB),
    currentRequest,
    consumerBase,
    current.current_revision_id,
    testEnv.CATALOGUE_EXPORTS,
  ))!.json()) as { data: { catalogue_revision: { content_sha256: string } } };
  const protectedPlan = await prepareCatalogueExportDeletion(
    catalogueStore(testEnv.CATALOGUE_DB),
    testEnv.CATALOGUE_EXPORTS,
    {
      catalogue_revision_id: current.current_revision_id,
      manifest_digest: currentBefore.data.catalogue_revision.content_sha256,
      expected_current_revision_id: current.current_revision_id,
      plan_id: "native-delete-current-plan",
    },
    new Date().toISOString(),
  );
  await expect(
    confirmCatalogueExportDeletion(
      catalogueStore(testEnv.CATALOGUE_DB),
      testEnv.CATALOGUE_EXPORTS,
      {
        plan_id: String(protectedPlan.id),
        plan_digest: String(protectedPlan.plan_digest),
        catalogue_revision_id: current.current_revision_id,
        manifest_digest: currentBefore.data.catalogue_revision.content_sha256,
        expected_current_revision_id: current.current_revision_id,
        confirmation_revision_id: current.current_revision_id,
        deletion_id: "native-delete-current",
        idempotency_key: "native-delete-current-intent",
      },
      new Date().toISOString(),
    ),
  ).rejects.toMatchObject({ code: "current_export_required" });
  const oldRevision = String(switched.document.resulting_revision_id);
  const oldDigest = (firstExport.data as { catalogue_revision: { content_sha256: string } }).catalogue_revision
    .content_sha256;
  const plan = await prepareCatalogueExportDeletion(
    catalogueStore(testEnv.CATALOGUE_DB),
    testEnv.CATALOGUE_EXPORTS,
    {
      catalogue_revision_id: oldRevision,
      manifest_digest: oldDigest,
      expected_current_revision_id: current.current_revision_id,
      plan_id: "native-delete-plan",
    },
    new Date().toISOString(),
  );
  expect(plan.object_keys).toEqual([`catalogue-public-manifests/${oldRevision}/${oldDigest}.json`]);
  expect(plan.dependencies).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: "shared_components_retained_for_recovery" })]),
  );
  const deletionInput = {
    plan_id: String(plan.id),
    plan_digest: String(plan.plan_digest),
    catalogue_revision_id: oldRevision,
    manifest_digest: oldDigest,
    expected_current_revision_id: current.current_revision_id,
    confirmation_revision_id: oldRevision,
    deletion_id: "native-delete-operation",
    idempotency_key: "native-delete-intent",
  };
  const deleted = await confirmCatalogueExportDeletion(
    catalogueStore(testEnv.CATALOGUE_DB),
    testEnv.CATALOGUE_EXPORTS,
    deletionInput,
    new Date().toISOString(),
  );
  expect(deleted.state).toBe("deleted");
  expect(
    await confirmCatalogueExportDeletion(
      catalogueStore(testEnv.CATALOGUE_DB),
      testEnv.CATALOGUE_EXPORTS,
      deletionInput,
      new Date().toISOString(),
    ),
  ).toEqual(deleted);
  expect(
    await testEnv.CATALOGUE_EXPORTS.head(`catalogue-public-manifests/${oldRevision}/${oldDigest}.json`),
  ).toBeNull();
  for (const component of firstComponents)
    expect((await testEnv.CATALOGUE_EXPORTS.head(component.object_key))?.size).toBe(component.byte_length);
  await expect(
    compositionExportResponse(
      catalogueStore(testEnv.CATALOGUE_DB),
      new Request(`${consumerBase.origin}/v1/catalogue-exports/${oldRevision}`),
      consumerBase,
      oldRevision,
      testEnv.CATALOGUE_EXPORTS,
    ),
  ).rejects.toMatchObject({ status: 410 });
  const knownName = (firstExport.data as { components: { name: string }[] }).components[0]!.name;
  await expect(
    compositionExportComponentResponse(
      catalogueStore(testEnv.CATALOGUE_DB),
      testEnv.CATALOGUE_EXPORTS,
      new Request(consumerBase.origin),
      oldRevision,
      knownName,
    ),
  ).rejects.toMatchObject({ status: 410 });
  expect(
    await compositionExportComponentResponse(
      catalogueStore(testEnv.CATALOGUE_DB),
      testEnv.CATALOGUE_EXPORTS,
      new Request(consumerBase.origin),
      oldRevision,
      "never-known",
    ),
  ).toBeNull();
  const currentExport = await compositionExportResponse(
    catalogueStore(testEnv.CATALOGUE_DB),
    new Request(`${consumerBase.origin}/v1/catalogue-exports/${current.current_revision_id}`),
    consumerBase,
    current.current_revision_id,
    testEnv.CATALOGUE_EXPORTS,
  );
  expect(currentExport?.status).toBe(200);
  expect(await currentExport!.json()).toEqual(currentBefore);
});

async function preparePublicExports(operation: string, generation: number, bucket?: R2Bucket) {
  for (let sequence = 0; sequence < 250; sequence++) {
    if (bucket) {
      const result = await advancePublicationExports(
        { CATALOGUE_DB: catalogueStore(testEnv.CATALOGUE_DB), CATALOGUE_EXPORTS: bucket },
        operation,
        generation,
        `public-unit-${operation}-${sequence}`,
      );
      if (result.state === "preparing") continue;
      expect(result.state, JSON.stringify(result)).toBe("verified");
      return;
    }
    const result = await post(`/v1/publications/${operation}/export-preparation/advance`, {
      generation,
      idempotency_key: `public-unit-${operation}-${sequence}`,
    });
    expect(result.response.status, JSON.stringify(result.document)).toBe(200);
    if (sequence === 0) {
      const replay = await post(`/v1/publications/${operation}/export-preparation/advance`, {
        generation,
        idempotency_key: `public-unit-${operation}-${sequence}`,
      });
      expect(replay.document).toEqual(result.document);
    }
    if (result.document.state !== "preparing") {
      expect(result.document.state, JSON.stringify(result.document)).toBe("verified");
      return;
    }
  }
  throw new Error("Public export preparation did not complete within its bounded units.");
}
