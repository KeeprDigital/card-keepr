import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { canonicalJson, sha256, utf8 } from "../../../src/catalogue/shared";
import { prepareObservationDocument } from "../../../src/catalogue/source-evidence/source-observation-document";

const header = { id: "srcobsset_stream-proof", contract: "card-keepr-source-observations@1", coverage_proof: null };

test("observation document streams exact canonical bytes and digest one observation at a time", async () => {
  for (const observations of [[], [{ text: 'e\u0301 😀 " \\ \n \ud800', array: [null, true], number: 1 }]]) {
    const prepared = prepareObservationDocument(header, observations);
    const expected = utf8(
      canonicalJson({
        ...header,
        observations: observations.map((value, index) => ({
          id: `srcobs_${header.id.slice(10)}_${index + 1}`,
          ordinal: index + 1,
          value,
        })),
      }),
    );
    expect(prepared.byteLength).toBe(expected.byteLength);
    expect(prepared.digest).toBe(await sha256(expected));
    for (let pass = 0; pass < 2; pass++)
      expect(new Uint8Array(await new Response(prepared.body()).arrayBuffer())).toEqual(expected);
  }
});

test("observation stream stays demand driven and cancels without visiting remaining values", async () => {
  let visits = 0;
  const value = {
    get text() {
      visits++;
      return "x".repeat(1024);
    },
  };
  const prepared = prepareObservationDocument(header, Array(32).fill(value));
  expect(visits).toBe(32);
  const reader = prepared.body().getReader();
  const chunks: number[] = [];
  while (visits === 32) chunks.push((await reader.read()).value!.byteLength);
  await reader.cancel();
  expect(visits).toBeLessThanOrEqual(34);
  expect(Math.max(...chunks)).toBeLessThan(2048);
});

test("real R2 validates the first-pass digest and refuses same-size second-pass drift", async () => {
  const value = { text: "before" };
  const prepared = prepareObservationDocument(header, [value]);
  const key = `source-observations/stream-checksum-${crypto.randomUUID()}`;
  async function put() {
    const fixed = new FixedLengthStream(prepared.byteLength);
    const pumping = prepared.body().pipeTo(fixed.writable);
    const results = await Promise.allSettled([
      env.EVIDENCE_OBJECTS.put(key, fixed.readable, { sha256: prepared.digest, onlyIf: { etagDoesNotMatch: "*" } }),
      pumping,
    ]);
    return results;
  }
  value.text = "after!";
  const failed = await put();
  expect(failed[0].status).toBe("rejected");
  expect(await env.EVIDENCE_OBJECTS.head(key)).toBeNull();
  value.text = "before";
  const passed = await put();
  expect(passed.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
  const object = await env.EVIDENCE_OBJECTS.get(key);
  expect(object?.size).toBe(prepared.byteLength);
  expect(await sha256(await object!.arrayBuffer())).toBe(prepared.digest);
  await env.EVIDENCE_OBJECTS.delete(key);
});

test("second-pass serialization failure closes the real R2 upload without retaining partial evidence", async () => {
  let broken = false;
  const sourceFailure = new Error("second-pass serialization failure");
  const prepared = prepareObservationDocument(header, [
    {
      get value() {
        if (broken) throw sourceFailure;
        return "original";
      },
    },
  ]);
  broken = true;
  const key = `source-observations/stream-failure-${crypto.randomUUID()}`;
  const fixed = new FixedLengthStream(prepared.byteLength);
  const results = await Promise.allSettled([
    env.EVIDENCE_OBJECTS.put(key, fixed.readable, { sha256: prepared.digest, onlyIf: { etagDoesNotMatch: "*" } }),
    prepared.body().pipeTo(fixed.writable),
  ]);
  expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
  expect(results[1]).toMatchObject({ reason: sourceFailure });
  expect(await env.EVIDENCE_OBJECTS.head(key)).toBeNull();
});
