/** A fresh observed inventory plus an explicitly confirmed plan gates provisioning.
 * Two spare D1 slots reserve simultaneous production/dev replacement recovery.
 * This is a provisioning count check, not measured catalogue throughput.
 */
export function verifyDevCapacity(evidence, now = Date.now()) {
  if (
    !evidence ||
    !["unknown", "free", "paid"].includes(evidence.workers_plan) ||
    !evidence.plan_evidence ||
    !/^[0-9a-f]{32}$/u.test(evidence.account_id ?? "") ||
    !Number.isFinite(Date.parse(evidence.observed_at)) ||
    now - Date.parse(evidence.observed_at) > 3600_000 ||
    Date.parse(evidence.observed_at) > now
  )
    throw new Error("fresh_confirmed_capacity_evidence_required");
  const free = evidence.workers_plan !== "paid";
  const limits =
    evidence.workers_plan !== "paid" ? { databases: 10, scripts: 100 } : { databases: 50000, scripts: 500 };
  if (
    ![evidence.d1_count, evidence.worker_count, evidence.r2_count].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    )
  )
    throw new Error("invalid_resource_inventory");
  if (
    free &&
    (!Number.isSafeInteger(evidence.d1_total_bytes) ||
      !Number.isSafeInteger(evidence.d1_max_bytes) ||
      evidence.d1_max_bytes > 500_000_000 ||
      evidence.d1_total_bytes + 4 * 500_000_000 > 5_000_000_000)
  )
    throw new Error("insufficient_dev_storage_headroom");
  if (
    evidence.d1_count + 2 + 2 > limits.databases ||
    evidence.worker_count + 2 > limits.scripts ||
    evidence.r2_count + 4 > 1000000
  )
    throw new Error("insufficient_dev_replacement_headroom");
  return {
    account_id: evidence.account_id,
    workers_plan: evidence.workers_plan,
    assessed_limits: free ? "free-conservative" : "paid",
    d1_after_provisioning: evidence.d1_count + 2,
    reserved_replacement_databases: 2,
    remaining_d1_after_reserve: limits.databases - evidence.d1_count - 4,
  };
}
