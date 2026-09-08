import { writeFile } from "node:fs/promises";
import { nativeRetainedOccupancy, operationalCapacityMetrics } from "./native-capacity-metrics.mjs";

// Opt-in local DevTools measurements. A sample maximum is not a continuous
// peak, and a sampling profile is not Cloudflare's billed CPU accounting.
export async function profileNativeIsolates(runtime, destination, local, { sampleIntervalMs = 3000 } = {}) {
  if (!Number.isSafeInteger(sampleIntervalMs) || sampleIntervalMs < 100 || sampleIntervalMs > 30000)
    throw new Error("Heap sample interval must be 100–30000 milliseconds");
  const inspector = await runtime.getInspectorURL();
  inspector.protocol = "http:";
  const targets = await (await fetch(new URL("/json", inspector), { signal: AbortSignal.timeout(5000) })).json();
  const sessions = [];
  const errors = [];
  try {
    for (const target of targets.filter((target) => target.id.startsWith("core:user:"))) {
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      sessions.push({ socket });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Inspector connection timed out")), 5000);
        socket.addEventListener(
          "open",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
        socket.addEventListener(
          "error",
          (error) => {
            clearTimeout(timer);
            reject(error);
          },
          { once: true },
        );
      });
      let sequence = 0;
      const call = (method) =>
        new Promise((resolve, reject) => {
          const id = ++sequence;
          const timer = setTimeout(() => {
            socket.removeEventListener("message", listener);
            reject(new Error(`Inspector timed out: ${method}`));
          }, 5000);
          const listener = ({ data }) => {
            const result = JSON.parse(data);
            if (result.id !== id) return;
            clearTimeout(timer);
            socket.removeEventListener("message", listener);
            if (result.error) reject(new Error(result.error.message));
            else resolve(result.result);
          };
          socket.addEventListener("message", listener);
          socket.send(JSON.stringify({ id, method }));
        });
      const report = { target: target.id, heap_samples: [], cpu_profile: null, allocation_profile: null };
      Object.assign(sessions.at(-1), { call, report });
      await call("Profiler.enable");
      await call("Profiler.start");
      await call("HeapProfiler.startSampling");
    }
    if (sessions.length === 0) throw new Error("No user isolate targets available for native measurement");
    const started = performance.now();
    const driverCpu = process.cpuUsage();
    const occupancy = [];
    let samples = 0;
    let pending = Promise.resolve();
    let sampling = false;
    let skippedIntervals = 0;
    async function sample() {
      if (local && samples++ % 10 === 0)
        occupancy.push({
          elapsed_ms: performance.now() - started,
          ...(await nativeRetainedOccupancy(local.directory)),
        });
      for (const session of sessions) {
        try {
          const heap = {
            elapsed_ms: performance.now() - started,
            ...(await session.call("Runtime.getHeapUsage")),
          };
          session.report.heap_samples.push(heap);
          if (heap.usedSize > 64 * 1024 ** 2 && session.report.allocation_profile === null) {
            const { profile } = await session.call("HeapProfiler.getSamplingProfile");
            const allocations = [];
            const visit = (node, stack) => {
              const frames = [...stack, node.callFrame.functionName];
              if (node.selfSize > 0) allocations.push({ sampled_live_bytes: node.selfSize, stack: frames });
              for (const child of node.children) visit(child, frames);
            };
            visit(profile.head, []);
            session.report.allocation_profile = {
              trigger_heap_sample: heap,
              limitation:
                "Sampled live V8 allocation attribution at the first observed 64 MiB used-heap exceedance; excludes native backing allocations and is not exact retained size. No object contents are captured.",
              allocations,
            };
          }
        } catch (error) {
          errors.push(String(error));
        }
      }
    }
    await sample();
    const interval = setInterval(() => {
      if (sampling) {
        skippedIntervals++;
        return;
      }
      sampling = true;
      pending = sample()
        .catch((error) => errors.push(String(error)))
        .finally(() => {
          sampling = false;
        });
    }, sampleIntervalMs);
    return async () => {
      clearInterval(interval);
      try {
        await pending;
        await sample();
        if (local)
          occupancy.push({
            elapsed_ms: performance.now() - started,
            skipped_sampling_intervals: skippedIntervals,
            ...(await nativeRetainedOccupancy(local.directory)),
          });
        for (const session of sessions) {
          try {
            const { profile } = await session.call("Profiler.stop");
            await session.call("HeapProfiler.stopSampling");
            const functions = new Map(profile.nodes.map((node) => [node.id, node.callFrame.functionName]));
            const sampled = {};
            for (let index = 0; index < (profile.samples?.length ?? 0); index++) {
              const name = functions.get(profile.samples[index]) ?? "unknown";
              // Preserve idle/program/GC separately. These deltas are sampled
              // elapsed attribution, not exact execution or per-invocation CPU.
              sampled[name] = (sampled[name] ?? 0) + profile.timeDeltas[index];
            }
            session.report.cpu_profile = {
              duration_microseconds: profile.endTime - profile.startTime,
              samples: profile.samples?.length ?? 0,
              sampled_microseconds_by_function: sampled,
            };
          } catch (error) {
            errors.push(String(error));
          } finally {
            session.socket.close();
          }
        }
        await writeFile(
          destination,
          JSON.stringify(
            {
              contract: "card-keepr-local-isolate-measurements@1",
              limitation:
                "Local workerd DevTools samples with profiler overhead. Heap samples include V8 used/allocated heap, embedder heap and backing storage as separate fields; they are not continuous peak working set. CPU profile deltas are sampling attribution, not billed CPU or invocation CPU. Runtime restarts produce separate reports.",
              sample_interval_ms: sampleIntervalMs,
              observer_started_ms: started,
              elapsed_ms: performance.now() - started,
              driver_only: {
                cpu_microseconds: process.cpuUsage(driverCpu),
                process_lifetime_maximum_rss_kib: process.resourceUsage().maxRSS,
                limitation:
                  "Node driver only, excludes workerd and CLI children; RSS maximum covers the process lifetime.",
              },
              occupancy,
              operations: local ? operationalCapacityMetrics(local.output()) : null,
              operational_timeline: local?.timeline?.snapshot(started) ?? null,
              errors,
              isolates: sessions.map(({ report }) => report),
            },
            null,
            2,
          ) + "\n",
        );
      } finally {
        for (const session of sessions) session.socket.close();
      }
    };
  } catch (error) {
    for (const session of sessions) session.socket.close();
    throw error;
  }
}
