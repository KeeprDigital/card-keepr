import { readdir, stat, statfs } from "node:fs/promises";
import { join } from "node:path";

export function operationalCapacityMetrics(output) {
  const groups = {};
  let malformed = 0;
  for (const line of output.split("\n")) {
    const start = line.indexOf('{"contract":"card-keepr-operational-log@1"');
    if (start < 0) continue;
    let record;
    try {
      record = JSON.parse(line.slice(start));
    } catch {
      malformed++;
      continue;
    }
    const key = `${record.runtime}:${record.event}:${record.request.method}:${record.request.route}`;
    groups[key] ??= { count: 0, failures: 0, elapsed_ms: [], d1: {} };
    const group = groups[key];
    group.count++;
    group.failures += Number(record.status >= 400);
    group.elapsed_ms.push(record.duration_ms);
    for (const [name, value] of Object.entries(record.d1)) group.d1[name] = (group.d1[name] ?? 0) + value;
  }
  for (const group of Object.values(groups)) {
    const durations = group.elapsed_ms.sort((a, b) => a - b);
    group.elapsed_ms = {
      sum: durations.reduce((a, b) => a + b, 0),
      maximum: durations.at(-1),
      p95: durations[Math.ceil(durations.length * 0.95) - 1],
    };
  }
  return {
    limitation:
      "Operational log observations; includes polls and retries, excludes unlogged health checks. Preparations and submitted batch statements are not executed rows or billed writes. Workflow wall durations overlap across concurrent Workflows.",
    malformed_records: malformed,
    groups,
  };
}

export async function nativeRetainedOccupancy(directory) {
  const census = { files: 0, logical_bytes: 0, allocated_bytes: 0, by_directory: {} };
  async function walk(path, category) {
    let names;
    try {
      names = await readdir(path, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const name of names) {
      if (name.isSymbolicLink()) continue;
      const child = join(path, name.name);
      const group = category ?? name.name;
      if (name.isDirectory()) await walk(child, group);
      else {
        let file;
        try {
          file = await stat(child);
        } catch (error) {
          if (error.code === "ENOENT") continue;
          throw error;
        }
        census.files++;
        census.logical_bytes += file.size;
        census.allocated_bytes += file.blocks * 512;
        census.by_directory[group] ??= { files: 0, logical_bytes: 0, allocated_bytes: 0 };
        const entry = census.by_directory[group];
        entry.files++;
        entry.logical_bytes += file.size;
        entry.allocated_bytes += file.blocks * 512;
      }
    }
  }
  await walk(directory);
  const filesystem = await statfs(directory);
  return {
    ...census,
    free_bytes: filesystem.bavail * filesystem.bsize,
    limitation:
      "Point-in-time local filesystem census including concurrent source, staging, export, SQL and restore copies. Not a continuous peak, R2 billed size, or physical unique bytes on copy-on-write storage. Files may change during traversal.",
  };
}

// Receipt timestamps belong to the Node observer, not the isolate's execution
// clock. Keep bounded, allow-listed metadata only; never retain payload lines.
export function nativeOperationalTimeline(limit = 4096) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Timeline limit must be a positive integer");
  const events = [];
  const partial = new Map();
  let received = 0;
  let malformed = 0;
  let oversized = 0;
  return {
    observe(chunk, stream) {
      const lines = `${partial.get(stream) ?? ""}${chunk}`.split("\n");
      const remainder = lines.pop();
      if (remainder.length <= 65536) partial.set(stream, remainder);
      else {
        partial.set(stream, "");
        oversized++;
      }
      for (const line of lines) {
        if (line.length > 65536) {
          oversized++;
          continue;
        }
        const offset = line.indexOf('{"contract":"card-keepr-operational-log@1"');
        if (offset < 0) continue;
        try {
          const record = JSON.parse(line.slice(offset));
          if (!["request.completed", "workflow.step.completed"].includes(record.event)) continue;
          if (
            typeof record.runtime !== "string" ||
            typeof record.request?.method !== "string" ||
            typeof record.request?.route !== "string" ||
            !(record.workflow?.step === null || typeof record.workflow?.step === "string") ||
            typeof record.duration_ms !== "number" ||
            typeof record.status !== "number"
          )
            throw new Error("Malformed operational metadata");
          events[received++ % limit] = {
            observer_ms: performance.now(),
            event: record.event,
            runtime: record.runtime,
            method: record.request.method,
            route: record.request.route,
            step: record.workflow.step,
            duration_ms: record.duration_ms,
            status: record.status,
          };
        } catch {
          malformed++;
        }
      }
    },
    snapshot(started) {
      return {
        limitation:
          "Bounded operational-log receipt timeline in the Node observer clock, not exact isolate execution boundaries. Duration is logged wall time, not CPU; buffering may delay receipt. No source payloads, SQL, request identifiers or parameters are retained.",
        retained_limit: limit,
        dropped_events: Math.max(0, received - limit),
        malformed_records: malformed,
        oversized_lines: oversized,
        events: [...events]
          .sort((a, b) => a.observer_ms - b.observer_ms)
          .map(({ observer_ms, ...event }) => ({ observed_elapsed_ms: observer_ms - started, ...event })),
      };
    },
  };
}
