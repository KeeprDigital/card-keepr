import { expect, test } from "vitest";
import type { WorkflowStep } from "cloudflare:workers";
import { sha256 } from "../../../src/catalogue/shared";
import {
  retainCandidateImage,
  verifiedRetainedPrintingImage,
} from "../../../src/catalogue/reconciliation/reconciliation-images";
import { capacityImageResponse, syntheticCapacityTier } from "../../../test/support/fake-publisher/capacity-workloads";
import { boundedReconciliationResources } from "../src/reconciliation-resource-budget";
import { installReconciliationSuite, testEnv } from "./reconciliation-helpers";

installReconciliationSuite();

test("a bounded reconciliation callback copies and reuses one retained image", async () => {
  // Buffer only this bounded test seed; the actual copy traverses the production
  // R2 resource wrapper inside a Workflow callback. The native publication
  // test additionally exercises durable staging ownership and its fence.
  const bytes = await capacityImageResponse(syntheticCapacityTier("128-images"), 0).arrayBuffer();
  const digest = await sha256(bytes);
  const key = "retained-one-printing-image";
  await testEnv.EVIDENCE_OBJECTS.put(key, bytes, { httpMetadata: { contentType: "image/png" } });
  const direct = {
    do: async (...args: unknown[]) => (args.at(-1) as () => Promise<unknown>)(),
  } as unknown as WorkflowStep;
  const { env, step } = boundedReconciliationResources(testEnv, direct);
  await step.do("retain Printing Image", async () => {
    const metadata = await verifiedRetainedPrintingImage(env.EVIDENCE_OBJECTS, {
      request_url: "https://official-source.invalid/images/capacity-128-images-0.png",
      media_type: "image/png",
      content_digest: digest,
      content_byte_length: bytes.byteLength,
      content_object_key: key,
    });
    expect(metadata).toMatchObject({ width: 1, height: 1, content_byte_length: 102400, content_sha256: digest });
    const image = {
      ...metadata,
      role: "front" as const,
      source_url: "https://official-source.invalid/images/capacity-128-images-0.png",
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await retainCandidateImage(env.PRINTING_IMAGES, image, { bucket: env.EVIDENCE_OBJECTS, key })).toEqual(
        image,
      );
    }
  });
  const served = await testEnv.PRINTING_IMAGES.get(`printing-images/${digest}`);
  expect(served?.size).toBe(bytes.byteLength);
  expect(await sha256(await served!.arrayBuffer())).toBe(digest);
});

test("a rejected serving upload settles its retained image transfer", async () => {
  const bytes = await capacityImageResponse(syntheticCapacityTier("128-images"), 1).arrayBuffer();
  const digest = await sha256(bytes);
  const key = "retained-image-upload-failure";
  await testEnv.EVIDENCE_OBJECTS.put(key, bytes);
  const failure = new Error("Injected serving storage failure.");
  const unavailable = new Proxy(testEnv.PRINTING_IMAGES, {
    get(target, property) {
      if (property === "put")
        return async () => {
          throw failure;
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const direct = {
    do: async (...args: unknown[]) => (args.at(-1) as () => Promise<unknown>)(),
  } as unknown as WorkflowStep;
  const { env, step } = boundedReconciliationResources({ ...testEnv, PRINTING_IMAGES: unavailable }, direct);
  await expect(
    step.do("failed retained image upload", async () => {
      await retainCandidateImage(
        env.PRINTING_IMAGES,
        {
          media_type: "image/png",
          width: 1,
          height: 1,
          role: "front",
          source_url: "https://official-source.invalid/images/capacity-128-images-1.png",
          content_sha256: digest,
          content_byte_length: bytes.byteLength,
        },
        { bucket: env.EVIDENCE_OBJECTS, key },
      );
    }),
  ).rejects.toMatchObject({ name: "CandidateImageStorageError", cause: failure });
  expect(await testEnv.PRINTING_IMAGES.head(`printing-images/${digest}`)).toBeNull();
});
