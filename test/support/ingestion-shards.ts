import { relative, sep } from "node:path";

type IngestionTestFile = Readonly<{ path: string; source: string }>;

// Source-only work estimate, never retained timings or a list of test files.
// Textual call sites do not expand loops/parameter tables or follow aliases.
const nativeFixtureCalls = new Set([
  "collect",
  "collectFixtureEvidence",
  "prepareNativeCandidate",
  "prepareNativeEvidence",
  "approveNativeCandidate",
  "seedNativePredecessor",
  "applyD1Migrations",
  "startEvidenceRun",
  "installRuntimeSuite",
  "installReconciliationSuite",
]);

export function selectIngestionShard<T extends IngestionTestFile>(
  files: readonly T[],
  root: string,
  shard: Readonly<{ index: number; count: number }>,
): T[] {
  if (
    !Number.isSafeInteger(shard.index) ||
    !Number.isSafeInteger(shard.count) ||
    shard.count < 1 ||
    shard.count > files.length ||
    shard.index < 1 ||
    shard.index > shard.count
  ) {
    throw new RangeError("Invalid ingestion shard selection");
  }
  const ordered = files
    .map((file) => ({
      file,
      path: relative(root, file.path).split(sep).join("/"),
      weight:
        1 + [...file.source.matchAll(/\b(\w+)\s*\(/gu)].filter((match) => nativeFixtureCalls.has(match[1]!)).length,
    }))
    .sort((a, b) => b.weight - a.weight || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const partitions = Array.from({ length: shard.count }, () => ({ weight: 0, files: [] as T[] }));
  for (const entry of ordered) {
    const partition = partitions.reduce((least, candidate) => (candidate.weight < least.weight ? candidate : least));
    partition.weight += entry.weight;
    partition.files.push(entry.file);
  }
  return partitions[shard.index - 1]!.files;
}
