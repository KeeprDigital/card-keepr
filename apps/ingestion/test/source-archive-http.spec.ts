import { expect, test } from "vitest";
import etched from "../../../acceptance/fixtures/real-sources/2026-09-14-scryfall/bulk/etched.json?raw";
import contract from "../../../contracts/admin-openapi.json";
import { assertHttpResponse } from "../../../test/support/http-contract";
import { administrationRequest, installRuntimeSuite } from "./runtime-helpers";
import { seedArchive, version } from "./source-archive-fixture";
import { archiveNormalizationStepBudget } from "../../../src/catalogue/source-evidence/source-archive-parse";

installRuntimeSuite();

test("archive reparse HTTP continues bounded progress with the same intent and replays the sealed observation set", async () => {
  // Synthetic distinct locators isolate continuation at one record beyond the
  // callback's bound; this is a transport fixture, not real source coverage.
  const input = new TextEncoder().encode(
    Array.from({ length: archiveNormalizationStepBudget.records + 1 }, (_, index) => {
      const record = JSON.parse(etched);
      record.id = `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
      record.uri = `https://api.scryfall.com/cards/${record.id}`;
      record.image_uris.normal = `https://cards.scryfall.io/normal/front/0/0/${record.id}.jpg?1783907226`;
      return `${JSON.stringify(record)}\n`;
    }).join(""),
  );
  const { snapshot } = await seedArchive("archive-http-continuation", false, input);
  const path = `/v1/source-snapshots/${snapshot.id}/observations`;
  const definition = "/v1/source-snapshots/{snapshot}/observations";
  const intent = { adapter_version: version, idempotency_key: "archive-http-parse" };
  const pending = await administrationRequest(path, "POST", intent);
  expect(pending.status, await pending.clone().text()).toBe(202);
  const progress = await pending.json<{ observation_set_id: string }>();
  expect(progress).toMatchObject({
    source_snapshot_id: snapshot.id,
    adapter_version: version,
    kind: "pending",
    phase: "normalizing",
  });
  await assertHttpResponse(contract, definition, "post", pending, progress);
  const finished = await administrationRequest(path, "POST", intent);
  expect(finished.status, await finished.clone().text()).toBe(201);
  const document = await finished.json();
  expect(document).toMatchObject({
    id: progress.observation_set_id,
    observation_count: archiveNormalizationStepBudget.records + 1,
  });
  await assertHttpResponse(contract, definition, "post", finished, document);
  const replay = await administrationRequest(path, "POST", intent);
  expect(replay.status).toBe(201);
  expect(await replay.json()).toEqual(document);
});
