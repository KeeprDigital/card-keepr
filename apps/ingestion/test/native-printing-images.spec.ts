import { expect, test } from "vitest";
import worker from "../src/index";
import { catalogueStore, sha256, type CataloguePrintingImage } from "../../../src/catalogue/shared";
import { compositionImageResponse } from "../../../src/catalogue/read/composition-read";
import { compositionExportResponse } from "../../../src/catalogue/read/composition-export";
import { runReconciliationWorkflow } from "./reconciliation-workflow-driver";
import { collect, get, post, installReconciliationSuite, requiredString, testEnv } from "./reconciliation-helpers";
import type { ReconciliationWorkflowParams } from "../../../src/catalogue/reconciliation";

installReconciliationSuite();

test("native whole-candidate publication streams separately retained images into verified serving references", async () => {
  const run = await collect("/reconciliation/capacity-128-images-page-0", "native-streamed-images", {
    game: "one-piece",
    lineage: "one-piece-en",
    adapter: "fixture-one-piece-capacity@1",
  });
  let retainedReads = 0;
  const objects = new Proxy(testEnv.EVIDENCE_OBJECTS, {
    get(target, property) {
      if (property === "get")
        return async (...args: Parameters<R2Bucket["get"]>) => {
          const object = await target.get(...args);
          if (!object?.httpMetadata?.contentType?.startsWith("image/")) return object;
          retainedReads++;
          return new Proxy(object, {
            get(image, member) {
              if (member === "arrayBuffer" || member === "text" || member === "json" || member === "blob")
                return () => {
                  throw new Error("Retained image payload must remain streamed.");
                };
              const value = Reflect.get(image, member, image);
              return typeof value === "function" ? value.bind(image) : value;
            },
          });
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  let streamedPuts = 0;
  const images = new Proxy(testEnv.PRINTING_IMAGES, {
    get(target, property) {
      if (property === "put")
        return (...args: Parameters<R2Bucket["put"]>) => {
          expect(args[1]).toBeInstanceOf(ReadableStream);
          streamedPuts++;
          return target.put(...args);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  let payload: ReconciliationWorkflowParams | undefined;
  const deferredWorkflow = {
    create: async (options: { params: ReconciliationWorkflowParams }) => {
      payload = options.params;
      return { id: "native-image-test", status: async () => ({ status: "running" }) };
    },
  } as unknown as Env["RECONCILIATION_WORKFLOW"];
  const started = await worker.fetch(
    new Request("https://card-keepr.invalid/v1/game-candidates", {
      method: "POST",
      headers: { authorization: "Bearer vitest-administration-key", "content-type": "application/json" },
      body: JSON.stringify({
        ingestion_run_id: run.id,
        supported_game: "one-piece",
        expected_game_revision_id: "catrev_spine_000",
        idempotency_key: "native-streamed-images-candidate",
      }),
    }),
    { ...testEnv, RECONCILIATION_WORKFLOW: deferredWorkflow },
  );
  const created = (await started.json()) as Record<string, unknown>;
  expect(started.status, JSON.stringify(created)).toBe(201);
  const id = requiredString(created, "id");
  expect(payload).toBeDefined();
  const event = { payload: payload! } as import("cloudflare:workers").WorkflowEvent<ReconciliationWorkflowParams>;
  const step = {
    do: async (_name: string, _config: unknown, callback: () => Promise<string>) => callback(),
  } as unknown as import("cloudflare:workers").WorkflowStep;
  await runReconciliationWorkflow({ ...testEnv, EVIDENCE_OBJECTS: objects, PRINTING_IMAGES: images }, event, step);
  const candidate = (await get(`/v1/game-candidates/${id}`)).document;
  expect(candidate, JSON.stringify(candidate)).toMatchObject({ state: "sealed" });
  expect(retainedReads).toBeGreaterThanOrEqual(256);
  expect(streamedPuts).toBe(128);
  const references: CataloguePrintingImage[] = [];
  let cursor: string | null = null;
  do {
    const page = (await get(`/v1/game-candidates/${id}/partitions${cursor === null ? "" : `?after=${cursor}`}`))
      .document;
    for (const partition of page.partitions as { ordinal: number; kind: string }[]) {
      if (partition.kind !== "printing_images") continue;
      const content = (await get(`/v1/game-candidates/${id}/partitions/${partition.ordinal}`)).document;
      references.push(...(content.records as CataloguePrintingImage[]));
    }
    cursor = page.next_cursor as string | null;
  } while (cursor !== null);
  expect(references).toHaveLength(128);
  expect(JSON.stringify(references)).not.toMatch(/content_base64|content_object_key/);
  expect(new Set(references.map((image) => image.content_sha256)).size).toBe(128);
  for (const image of references) expect(image).toMatchObject({ width: 1, height: 1, content_byte_length: 102400 });

  const intent = {
    candidate_id: id,
    manifest_digest: candidate.manifest_digest,
    generation: candidate.generation,
    expected_game_revision_id: "catrev_spine_000",
    idempotency_key: "native-streamed-images-approval",
  };
  const approval = await post("/v1/publications", intent);
  expect(approval.response.status, JSON.stringify(approval.document)).toBe(202);
  expect(approval.document).toMatchObject({ approval_scope: "whole_candidate", state: "approved" });
  expect((await post("/v1/publications", intent)).document).toEqual(approval.document);
  const publication = requiredString(approval.document, "id");
  // Each fixture Printing has one Card and one image: image verification,
  // export/projection records and three Card search fields each take units.
  // Reserve sixteen per Printing plus bounded partition/composition overhead.
  const maximumPreparationUnits = references.length * 16 + 128;
  let sequence = 0;
  for (let unit = 0; unit < maximumPreparationUnits; unit++) {
    const prepared = await post(`/v1/game-candidates/${id}/publication-preparation`, {
      manifest_digest: candidate.manifest_digest,
      generation: 0,
      sequence,
      idempotency_key: `native-images-artifacts-${unit}`,
    });
    expect(prepared.response.status, JSON.stringify(prepared.document)).toBe(200);
    if (prepared.document.state === "verified") break;
    expect(prepared.document.state).toBe("preparing");
    sequence = Number(prepared.document.sequence);
    if (unit === maximumPreparationUnits - 1)
      throw new Error("Image publication artifacts exceeded their bounded units.");
  }
  for (let unit = 0; unit < maximumPreparationUnits; unit++) {
    const prepared = await post(`/v1/publications/${publication}/export-preparation/advance`, {
      generation: 0,
      idempotency_key: `native-images-export-${unit}`,
    });
    expect(prepared.response.status, JSON.stringify(prepared.document)).toBe(200);
    if (prepared.document.state === "verified") break;
    expect(prepared.document.state).toBe("preparing");
    if (unit === maximumPreparationUnits - 1) throw new Error("Image export preparation exceeded its bounded units.");
  }
  const published = await post(`/v1/publications/${publication}/advance`, { generation: 0 });
  expect(published.document, JSON.stringify(published.document)).toMatchObject({ state: "published" });
  expect((await post(`/v1/publications/${publication}/advance`, { generation: 0 })).document).toEqual(
    published.document,
  );
  const revision = requiredString(published.document, "resulting_revision_id");
  for (const image of references) {
    const response = await compositionImageResponse(
      catalogueStore(testEnv.CATALOGUE_DB),
      testEnv.PRINTING_IMAGES,
      new Request(`https://catalogue.example/v1/printing-images/${image.id}?revision=${revision}`),
      image.id,
    );
    expect(response?.status).toBe(200);
    const bytes = await response!.arrayBuffer();
    expect(bytes.byteLength).toBe(image.content_byte_length);
    expect(await sha256(bytes)).toBe(image.content_sha256);
  }
  const exported = await compositionExportResponse(
    catalogueStore(testEnv.CATALOGUE_DB),
    new Request(`https://catalogue.example/v1/catalogue-exports/${revision}`),
    { origin: "https://catalogue.example", basePath: "" },
    revision,
    testEnv.CATALOGUE_EXPORTS,
  );
  expect(exported?.status).toBe(200);
  const exportDocument = await exported!.json();
  expect(JSON.stringify(exportDocument)).not.toContain("content_base64");
// Isolated hosted completion measured78.11s for all128images. Use the existing
//120-second image integration bound; callback/resource budgets stay unchanged.
}, 120000);
