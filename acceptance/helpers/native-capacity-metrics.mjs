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
