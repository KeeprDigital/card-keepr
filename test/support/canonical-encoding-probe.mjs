// Isolated Node encoder comparison. This does not measure workerd or the full
// reconciliation budget. Sampling includes discarded allocations, not live size.
import { Session } from "node:inspector";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { canonicalJson, utf8 } from "../../src/catalogue/shared/serialization.ts";
import { canonicalUtf8 } from "./canonical-utf8-prototype.ts";

const [variant, input, destination] = process.argv.slice(2);
if (!["legacy", "direct"].includes(variant) || !input || !destination)
  throw new Error("Use canonical-encoding-probe.mjs legacy|direct input.json output.json");
const source = await readFile(input);
const document = JSON.parse(source.toString("utf8"));
const session = new Session();
session.connect();
const post = promisify(session.post.bind(session));
try {
  await post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  const before = process.memoryUsage();
  const cpu = process.cpuUsage();
  const started = performance.now();
  const bytes = variant === "legacy" ? utf8(canonicalJson(document)) : canonicalUtf8(document);
  const elapsed = performance.now() - started;
  const usedCpu = process.cpuUsage(cpu);
  const after = process.memoryUsage();
  const { profile } = await post("HeapProfiler.stopSampling");
  const allocations = [];
  function visit(node, stack) {
    const frames = [...stack, node.callFrame.functionName];
    if (node.selfSize > 0) allocations.push({ sampled_allocation_bytes: node.selfSize, stack: frames });
    for (const child of node.children) visit(child, frames);
  }
  visit(profile.head, []);
  await writeFile(
    destination,
    JSON.stringify(
      {
        scope:
          "One synchronous encoder call in Node, input generation/parsing excluded. Inspector allocation sampling overhead applies; samples include GC-discarded objects, not live heap or exact totals. Before/after memory is not peak. CPU is Node process usage during encoding, not workerd/billed CPU or full reconciliation timing. No forced GC or debugger pauses.",
        variant,
        node: process.version,
        input_bytes: source.length,
        input_sha256: createHash("sha256").update(source).digest("hex"),
        output_bytes: bytes.length,
        output_sha256: createHash("sha256").update(bytes).digest("hex"),
        elapsed_ms: elapsed,
        cpu_microseconds: usedCpu,
        before,
        after,
        allocations,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  session.disconnect();
}
