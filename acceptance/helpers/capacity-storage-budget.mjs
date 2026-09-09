// Byte components must describe disjoint objects at the same checkpoint.
// Unknown is never zero. Callers label measurements/estimates in their ledger.
export function capacityStorageBudget(workload, measured = {}) {
  const components = {
    raw_source_bodies: workload.imageBytes + workload.structuredBytes,
    sealed_records: null,
    records_indexes_d1: null,
    published_image_copies: null,
    history_exports: null,
    concurrent_work: null,
    restore_staging: null,
    filesystem_overhead: null,
  };
  for (const [name, bytes] of Object.entries(measured)) {
    if (!(name in components) || name === "raw_source_bodies") throw new Error(`Unknown measured component: ${name}`);
    components[name] = bytes;
  }
  for (const bytes of Object.values(components))
    if (bytes !== null && (!Number.isSafeInteger(bytes) || bytes < 0))
      throw new Error("Storage components must be non-negative safe integer bytes or null");
  const unmeasured = Object.keys(components).filter((key) => components[key] === null);
  const lowerBound = Object.values(components).reduce((sum, bytes) => sum + (bytes ?? 0), 0);
  if (!Number.isSafeInteger(lowerBound)) throw new Error("Storage total exceeds the safe integer byte range");
  return {
    components,
    known_lower_bound_bytes: lowerBound,
    total_bytes: unmeasured.length === 0 ? lowerBound : null,
    unmeasured_components: unmeasured,
    limitation:
      "Disjoint coexisting logical byte components, not peak allocation or provider billing. Raw source bodies are declared fixture input. Unknown components require measurement after publication changes; no historical base64 multiplier applies.",
  };
}
