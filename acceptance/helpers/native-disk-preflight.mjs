import assert from "node:assert/strict";
import { statfs } from "node:fs/promises";

// The retained Riftbound journey reached 3.6 GiB. Reserve additional room for
// transient SQL, R2 and import writes; this is a preflight floor, not a quota.
export async function requireNativeDiskSpace(directory) {
  const filesystem = await statfs(directory, { bigint: true });
  const available = filesystem.bavail * filesystem.bsize;
  const minimum = 6n * 1024n ** 3n;
  assert.ok(
    available >= minimum,
    `Native recovery requires at least ${minimum} free bytes at ${directory}; available ${available}. ` +
      "Free disk capacity before running; retained failure evidence must be preserved.",
  );
  return available;
}
