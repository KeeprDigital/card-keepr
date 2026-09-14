/** Missing provenance or provider access leaves classification unknown; it never invents a starting SHA. */
export async function observeStagingTransition({ target, previousRelease, selectedSha, token }) {
  if (!previousRelease || !/^[0-9a-f]{40}$/u.test(previousRelease.head_sha) || !token) return null;
  const signal = AbortSignal.timeout(8_000);
  try {
    const versions = await Promise.all(
      target.worker_scripts.map(async (worker, index) => {
        const root = `https://api.cloudflare.com/client/v4/accounts/${target.cloudflare_account_id}/workers/scripts/${encodeURIComponent(worker)}`;
        const active = await document(`${root}/deployments`, token, signal);
        const pair = active.result?.deployments?.[0]?.versions;
        if (
          active.success !== true ||
          !Array.isArray(pair) ||
          pair.length !== 1 ||
          pair[0].percentage !== 100 ||
          typeof pair[0].version_id !== "string"
        )
          throw new Error("unknown_active_pair");
        const version = await document(`${root}/versions/${encodeURIComponent(pair[0].version_id)}`, token, signal);
        if (
          version.success !== true ||
          version.result?.id !== pair[0].version_id ||
          version.result.annotations?.["workers/tag"] !==
            `release-${previousRelease.release_id}-${index === 0 ? "api" : "ingestion"}` ||
          !Array.isArray(version.result.resources?.bindings) ||
          !version.result.resources.bindings.some(
            (binding) =>
              binding.type === "d1" &&
              binding.name === "CATALOGUE_DB" &&
              (binding.id ?? binding.database_id) === target.d1_databases[0].id &&
              (binding.id === undefined || binding.database_id === undefined || binding.id === binding.database_id),
          )
        )
          throw new Error("unknown_active_pair");
        const bindings = version.result.resources.bindings;
        const buckets = bindings
          .filter((binding) => binding.type === "r2_bucket")
          .map((binding) => binding.bucket_name)
          .sort();
        const expectedBuckets = (index === 0 ? target.r2_buckets.slice(1, 3) : target.r2_buckets).toSorted();
        const services = bindings.filter((binding) => binding.type === "service");
        if (
          bindings.filter((binding) => binding.type === "d1").length !== 1 ||
          JSON.stringify(buckets) !== JSON.stringify(expectedBuckets) ||
          (index === 0
            ? services.length !== 0
            : services.length !== 1 ||
              services[0].service !== target.worker_scripts[1] ||
              services[0].entrypoint !== "OfficialSourceTransport" ||
              ![undefined, "production"].includes(services[0].environment))
        )
          throw new Error("unknown_active_target");
        return { worker, version_id: pair[0].version_id };
      }),
    );
    const comparison = await document(
      `https://api.github.com/repos/KeeprDigital/card-keepr/compare/${previousRelease.head_sha}...${selectedSha}`,
      null,
      signal,
    );
    if (
      !["ahead", "identical"].includes(comparison.status) ||
      comparison.base_commit?.sha !== previousRelease.head_sha ||
      comparison.merge_base_commit?.sha !== previousRelease.head_sha ||
      !Number.isSafeInteger(comparison.total_commits) ||
      comparison.total_commits > 250 ||
      !Array.isArray(comparison.commits) ||
      comparison.commits.length !== comparison.total_commits ||
      (comparison.total_commits === 0
        ? selectedSha !== previousRelease.head_sha
        : comparison.commits.at(-1)?.sha !== selectedSha) ||
      !Array.isArray(comparison.files) ||
      comparison.files.length >= 300
    )
      return null;
    const paths = [];
    for (const file of comparison.files) {
      if (
        typeof file.filename !== "string" ||
        !["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"].includes(file.status)
      )
        return null;
      paths.push(file.filename);
      if (file.status === "renamed" || file.status === "copied") {
        if (typeof file.previous_filename !== "string") return null;
        paths.push(file.previous_filename);
      }
    }
    const bytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        JSON.stringify({
          base_sha: previousRelease.head_sha,
          selected_sha: selectedSha,
          commits: comparison.commits.map((commit) => commit.sha),
          paths: [...paths].sort(),
        }),
      ),
    );
    return {
      head_sha: previousRelease.head_sha,
      versions,
      paths,
      comparison_sha256: [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
    };
  } catch {
    return null;
  }
}

async function document(url, token, signal) {
  const response = await fetch(url, {
    redirect: "manual",
    signal,
    headers: {
      "User-Agent": "card-keepr-release",
      accept: "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok || !response.body) throw new Error("transition_inventory_unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let count = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > 2_000_000) {
        await reader.cancel();
        throw new Error("transition_inventory_too_large");
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(text + decoder.decode());
}
