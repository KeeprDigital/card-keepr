import { env } from "cloudflare:workers";
import { collectFixtureEvidence } from "../../../test/support/fixture-evidence-plan";
import { expect, test } from "vitest";
import { administrationRequest, createCollection, installRuntimeSuite } from "./runtime-helpers";
import { assertHttpResponse } from "../../../test/support/http-contract";
import contract from "../../../contracts/admin-openapi.json";

installRuntimeSuite();

test("source authority accepts a JSON integer generation and retains the exact decision on replay", async () => {
  const intent = {
    game: "riftbound",
    locale: "en",
    release_region: "US",
    area: "card_facts",
    source_lineage: "riftbound-en",
    expected_generation: 0,
    rationale: "Designate the retained Riot evidence.",
    idempotency_key: "hono-authority",
  };
  const response = await administrationRequest("/v1/source-authorities", "POST", intent);
  expect(response.status).toBe(200);
  const decision = await response.json();
  expect(decision).toMatchObject({ source_lineage: "riftbound-en", generation: 1 });
  await assertHttpResponse(contract, "/v1/source-authorities", "post", response, decision);
  const replay = await administrationRequest("/v1/source-authorities", "POST", intent);
  expect(await replay.json()).toEqual(decision);
  const invalid = await administrationRequest("/v1/source-authorities", "POST", {
    ...intent,
    expected_generation: "0",
  });
  expect(invalid.status).toBe(422);
  await assertHttpResponse(contract, "/v1/source-authorities", "post", invalid);
});

test("owner inspects the registry and retires a non-authoritative source with immutable lifecycle history", async () => {
  const registry = await administrationRequest("/v1/source-registry", "GET");
  expect(registry.status).toBe(200);
  await assertHttpResponse(contract, "/v1/source-registry", "get", registry);
  const path = "/v1/source-lineages/limitless-one-piece-en/lifecycle";
  const intent = {
    state: "retired",
    expected_generation: 0,
    rationale: "Pause this source's use.",
    idempotency_key: "hono-lifecycle",
  };
  const changed = await administrationRequest(path, "POST", intent);
  expect(changed.status).toBe(200);
  const decision = await changed.json();
  await assertHttpResponse(contract, "/v1/source-lineages/{lineage}/lifecycle", "post", changed, decision);
  expect(await (await administrationRequest(path, "POST", intent)).json()).toEqual(decision);
  const current = await administrationRequest(path, "GET");
  expect(await current.clone().json()).toMatchObject({ state: "retired", generation: 1, history: [decision] });
  await assertHttpResponse(contract, "/v1/source-lineages/{lineage}/lifecycle", "get", current);
  const guarded = await administrationRequest("/v1/source-lineages/one-piece-en/lifecycle", "POST", {
    ...intent,
    idempotency_key: "hono-authority-retirement",
  });
  expect(guarded.status).toBe(409);
  expect(await guarded.clone().json()).toMatchObject({ code: "source_is_authority" });
  await assertHttpResponse(contract, "/v1/source-lineages/{lineage}/lifecycle", "post", guarded);
});

test("collection creation replays its original acceptance after pause, termination and a linked retry", async () => {
  const intent = {
    supported_game: "one-piece",
    source_lineage: "one-piece-en",
    adapter_version: "one-piece-en@6",
    idempotency_key: "hono-collection",
    requests: [{ id: "one-piece-en:discovery", url: "https://en.onepiece-cardgame.com/cardlist/?series=569116" }],
  };
  const created = await administrationRequest("/v1/ingestion-runs/evidence", "POST", intent);
  expect(created.status).toBe(201);
  const receipt = await created.json<{ id: string; contract: string; links: { status: string } }>();
  expect(receipt.contract).toBe("card-keepr-evidence-acceptance@1");
  await assertHttpResponse(contract, "/v1/ingestion-runs/evidence", "post", created, receipt);
  expect(created.headers.get("location")).toBe(receipt.links.status);
  const paused = await administrationRequest(`/v1/ingestion-runs/${receipt.id}/collection/pause`, "POST", {
    idempotency_key: "hono-pause",
  });
  expect(paused.status).toBe(200);
  await assertHttpResponse(contract, "/v1/ingestion-runs/{run}/collection/pause", "post", paused);
  const current = await administrationRequest(new URL(receipt.links.status).pathname, "GET");
  expect(await current.clone().json()).toMatchObject({
    id: receipt.id,
    state: "paused",
    pause: { reason: "owner_requested" },
  });
  await assertHttpResponse(contract, "/v1/ingestion-runs/{run}/evidence", "get", current);
  const terminated = await administrationRequest(`/v1/ingestion-runs/${receipt.id}/collection/termination`, "POST", {
    idempotency_key: "hono-terminate",
  });
  expect(terminated.status).toBe(200);
  await assertHttpResponse(contract, "/v1/ingestion-runs/{run}/collection/termination", "post", terminated);
  const replay = await administrationRequest("/v1/ingestion-runs/evidence", "POST", intent);
  expect(await replay.json()).toEqual(receipt);
  const retry = await administrationRequest(`/v1/ingestion-runs/${receipt.id}/collection/retry`, "POST", {
    idempotency_key: "hono-retry",
  });
  expect(retry.status).toBe(201);
  expect(await retry.clone().json()).toMatchObject({
    contract: "card-keepr-evidence-acceptance@1",
    linked_run_id: receipt.id,
    state: "collecting",
  });
  await assertHttpResponse(contract, "/v1/ingestion-runs/{run}/collection/retry", "post", retry);
});

test("owner parses retained bytes and inspects snapshots, observation manifests and imported records through HTTP", async () => {
  const run = await createCollection("hono-retained", "https://official-source.invalid/cards");
  await collectFixtureEvidence(env.CATALOGUE_DB, env.EVIDENCE_OBJECTS, env.OFFICIAL_SOURCE_TRANSPORT, run.id);
  const shown = await administrationRequest(`/v1/ingestion-runs/${run.id}/evidence`, "GET");
  expect(shown.status).toBe(200);
  await assertHttpResponse(contract, "/v1/ingestion-runs/{run}/evidence", "get", shown);
  const evidence = await shown.json<{
    snapshots: { id: string; content: { digest: string; byte_length: number } }[];
  }>();
  const snapshot = evidence.snapshots[0]!;
  const content = await administrationRequest(`/v1/source-snapshots/${snapshot.id}/content`, "GET");
  expect(content.status).toBe(200);
  await assertHttpResponse(contract, "/v1/source-snapshots/{snapshot}/content", "get", content);
  expect(content.headers.get("etag")).toBe(`"sha256-${snapshot.content.digest}"`);
  expect((await content.clone().arrayBuffer()).byteLength).toBe(snapshot.content.byte_length);
  expect(await content.clone().text()).toBe('{"cards":[{"card_number":"OP01-001","name":"Roronoa Zoro"}]}');
  const parsePath = `/v1/source-snapshots/${snapshot.id}/observations`;
  const intent = { adapter_version: "fixture-one-piece-json@3", idempotency_key: "hono-parse" };
  const parsed = await administrationRequest(parsePath, "POST", intent);
  expect(parsed.status).toBe(201);
  const observation = await parsed.json<{ id: string }>();
  await assertHttpResponse(contract, "/v1/source-snapshots/{snapshot}/observations", "post", parsed, observation);
  expect(await (await administrationRequest(parsePath, "POST", intent)).json()).toEqual(observation);
  const manifest = await administrationRequest(`/v1/source-observation-sets/${observation.id}/content`, "GET");
  expect(manifest.status).toBe(200);
  await assertHttpResponse(contract, "/v1/source-observation-sets/{observationSet}/content", "get", manifest);
  const imported = await administrationRequest(`/v1/source-observation-sets/${observation.id}/records`, "POST", {});
  expect(imported.status).toBe(200);
  expect(await imported.clone().json()).toMatchObject({
    observation_set_id: observation.id,
    state: "sealed",
    observation_count: 1,
  });
  await assertHttpResponse(contract, "/v1/source-observation-sets/{observationSet}/records", "post", imported);
});

test("source commands reject noncanonical wire bodies and preserve authentication isolation", async () => {
  const { exports } = await import("cloudflare:workers");
  for (const [body, type, status] of [
    ["{", "application/json", 400],
    ["{}", "text/plain", 415],
    [JSON.stringify({ padding: "x".repeat(16_384) }), "application/json", 413],
    [
      JSON.stringify({ state: "retired", expected_generation: "0", rationale: "invalid", idempotency_key: "invalid" }),
      "application/json",
      422,
    ],
  ] as const) {
    const response = await exports.default.fetch(
      new Request("https://card-keepr.invalid/v1/source-lineages/limitless-one-piece-en/lifecycle", {
        method: "POST",
        headers: { authorization: "Bearer vitest-administration-key", "content-type": type },
        body,
      }),
    );
    expect(response.status).toBe(status);
    await assertHttpResponse(contract, "/v1/source-lineages/{lineage}/lifecycle", "post", response);
  }
  const resume = await administrationRequest("/v1/ingestion-runs/absent/collection/resume", "POST", { ignored: true });
  expect(resume.status).toBe(422);
  expect(await resume.clone().json()).toMatchObject({ invalid_params: [{ name: "ignored" }] });
  await assertHttpResponse(contract, "/v1/ingestion-runs/{run}/collection/resume", "post", resume);
  const unauthorized = await exports.default.fetch(
    new Request("https://card-keepr.invalid/v1/source-registry", {
      headers: { authorization: "Bearer vitest-api-key" },
    }),
  );
  expect(unauthorized.status).toBe(401);
  await assertHttpResponse(contract, "/v1/source-registry", "get", unauthorized);
});
