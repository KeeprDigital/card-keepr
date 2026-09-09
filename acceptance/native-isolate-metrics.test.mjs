import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { nativeOperationalTimeline } from "./helpers/native-capacity-metrics.mjs";
import { profileNativeIsolates } from "./helpers/native-isolate-metrics.mjs";

test("local isolate measurements read actual workerd heap and CPU profiles", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "keepr-isolate-metrics-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const timeline = nativeOperationalTimeline();
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      handleStructuredLogs: ({ message, level }) => timeline.observe(`${message}\n`, level),
      inspectorPort: 0,
      modules: true,
      compatibilityDate: "2026-07-29",
      script: `let retained; export default { fetch() {
      retained = Array(18 * 1024 * 1024).fill(1);
      const bytes = new Uint8Array(2 * 1024 * 1024);
      crypto.getRandomValues(bytes.subarray(0, 65536));
      console.info(JSON.stringify({contract: "card-keepr-operational-log@1", event: "request.completed", runtime: "ingestion", request: {method: "GET", route: "/allocation-calibration"}, workflow: {step: null}, status: 200, duration_ms: 0}));
      return new Response(bytes, {headers: {"x-count": String(retained.length)}});
    } }`,
    }),
  );
  t.after(() => runtime.dispose());
  await runtime.ready;
  const destination = join(directory, "measurements.json");
  const stop = await profileNativeIsolates(runtime, destination, { directory, output: () => "", timeline });
  const response = await runtime.dispatchFetch("https://test.invalid/");
  assert.equal((await response.arrayBuffer()).byteLength, 2 * 1024 * 1024);
  await stop();
  const report = JSON.parse(await readFile(destination, "utf8"));
  assert.deepEqual(report.errors, []);
  assert.ok(Number.isSafeInteger(report.skipped_sampling_intervals));
  assert.equal(report.operational_timeline.events.at(-1).route, "/allocation-calibration");
  assert.ok(report.operational_timeline.events.at(-1).observed_elapsed_ms >= 0);
  assert.equal(report.isolates.length, 1);
  assert.ok(report.isolates[0].heap_samples.every((sample) => sample.usedSize > 0));
  assert.ok(report.isolates[0].heap_samples.every((sample) => sample.received_elapsed_ms >= sample.elapsed_ms));
  assert.ok(report.isolates[0].cpu_profile.duration_microseconds > 0);
  assert.ok(report.isolates[0].allocation_profile.trigger_heap_sample.usedSize > 64 * 1024 ** 2);
  assert.ok(report.isolates[0].allocation_profile.allocations.length > 0);
});
