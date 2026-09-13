import { expect } from "vitest";
import worker from "../src/index";
import { catalogueStore, sha256, type CataloguePrintingImage } from "../../../src/catalogue/shared";
import { compositionImageResponse } from "../../../src/catalogue/read/composition-read";
import { compositionExportResponse } from "../../../src/catalogue/read/composition-export";
import { runReconciliationWorkflow } from "./reconciliation-workflow-driver";
import { collect, exportComponentRecords, get, post, requiredString, testEnv } from "./reconciliation-helpers";
import { approveNativeCandidate } from "./native-publication-helpers";
import type { ReconciliationWorkflowParams } from "../../../src/catalogue/reconciliation";

export async function assertNativePrintingImagePublication(workload: "2-images" | "128-images", imageCount: number) {
  const run = await collect(`/reconciliation/capacity-${workload}-page-0`, "native-streamed-images", {
    game: "one-piece",
    lineage: "one-piece-en",
    adapter: "fixture-one-piece-capacity@1",
  });
  const retainedImages = new Set<string>();
  const objects = new Proxy(testEnv.EVIDENCE_OBJECTS, {
    get(target, property) {
      if (property === "get")
        return async (...args: Parameters<R2Bucket["get"]>) => {
          const object = await target.get(...args);
          if (!object?.httpMetadata?.contentType?.startsWith("image/")) return object;
          retainedImages.add(object.key);
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
  expect(retainedImages.size).toBe(imageCount);
  expect(streamedPuts).toBe(imageCount);
  const references: CataloguePrintingImage[] = [];
  let cursor: string | null = null;
  do {
    const page = (await get(`/v1/game-candidates/${id}/partitions${cursor === null ? "" : `?after=${cursor}`}`))
      .document;
    const partitions = page.partitions as {
      ordinal: number;
      kind: string;
      byte_length: number;
      record_count: number;
    }[];
    expect(partitions.length).toBeLessThanOrEqual(100);
    for (const partition of partitions) {
      expect(partition.byte_length).toBeLessThanOrEqual(524_288);
      expect(partition.record_count).toBeLessThanOrEqual(500);
      if (partition.kind !== "printing_images") continue;
      const content = (await get(`/v1/game-candidates/${id}/partitions/${partition.ordinal}`)).document;
      references.push(...(content.records as CataloguePrintingImage[]));
    }
    const next = page.next_cursor as string | null;
    if (next !== null) expect(next).not.toBe(cursor);
    cursor = next;
  } while (cursor !== null);
  expect(references).toHaveLength(imageCount);
  expect(JSON.stringify(references)).not.toMatch(/content_base64|content_object_key/);
  expect(new Set(references.map((image) => image.content_sha256)).size).toBe(imageCount);
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
  // The shared owner driver performs real publication, SQL backup and disposable
  // restore. Image tests add streaming/identity proofs to that complete journey.
  const published = await approveNativeCandidate(candidate, intent.idempotency_key);
  const publication = requiredString(approval.document, "id");
  expect(published.document, JSON.stringify(published.document)).toMatchObject({ state: "published" });
  expect(published.document.id).toBe(publication);
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
  const exportedImages = await exportComponentRecords(revision, "printing-images");
  expect(exportedImages.map(({ id }) => id).sort()).toEqual(references.map(({ id }) => id).sort());
  const exportedById = new Map(exportedImages.map((image) => [image.id, image]));
  for (const { id, printing_id, role, media_type, width, height, content_sha256 } of references) {
    expect(exportedById.get(id)).toMatchObject({ id, printing_id, role, media_type, width, height, content_sha256 });
  }
  expect(JSON.stringify(exportedImages)).not.toMatch(/content_base64|content_object_key/);
}
