const completedStatuses = new Set([
  "complete",
  "completed",
  "success",
]);

export async function cloudflareJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function verifyCloudflareEnvelope(document) {
  if (document?.success !== true) return false;
  const results = Array.isArray(document.result)
    ? document.result
    : [document.result];
  return results.every((result) => {
    if (result === null || typeof result !== "object") return true;
    if (result.success !== undefined && result.success !== true) {
      return false;
    }
    return (
      result.status === undefined ||
      completedStatuses.has(result.status)
    );
  });
}

export function verifyD1DatabaseMetadata(document, databaseId) {
  return (
    verifyCloudflareEnvelope(document) &&
    document.result?.uuid === databaseId
  );
}

export function disposableProbeStatements(planDigest, challenge) {
  if (
    !/^[0-9a-f]{64}$/.test(planDigest) ||
    !/^[0-9a-f]{64}$/.test(challenge)
  ) {
    throw new TypeError("probe identity must use full SHA-256 values");
  }
  const suffix = `${planDigest.slice(0, 16)}${challenge.slice(0, 16)}`;
  const table = `__keepr_probe_${suffix}`;
  const quoted = `"${table}"`;
  return Object.freeze({
    table,
    create: `CREATE TABLE ${quoted} AS SELECT ? AS owner`,
    read: `SELECT owner FROM ${quoted}`,
    drop: `DROP TABLE ${quoted}`,
  });
}

export async function probeD1Credential({
  request,
  accountId,
  databaseId,
  permission,
  planDigest,
  challenge,
}) {
  if (permission === "D1 Read") {
    try {
      const response = await request(
        `/accounts/${accountId}/d1/database/${databaseId}`,
      );
      return {
        ok:
          response.ok &&
          verifyD1DatabaseMetadata(
            await cloudflareJson(response),
            databaseId,
          ),
        mutation_started: false,
        cleanup: "not-applicable",
      };
    } catch {
      return {
        ok: false,
        mutation_started: false,
        cleanup: "not-applicable",
      };
    }
  }
  if (permission !== "D1 Edit") {
    return {
      ok: false,
      mutation_started: false,
      cleanup: "not-applicable",
    };
  }
  const statements = disposableProbeStatements(planDigest, challenge);
  const query = async (sql, params = []) => {
    const response = await request(
      `/accounts/${accountId}/d1/database/${databaseId}/query`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sql, params }),
      },
    );
    const document = await cloudflareJson(response);
    return {
      ok: response.ok && verifyCloudflareEnvelope(document),
      document,
    };
  };
  let created = false;
  let outcome = {
    ok: false,
    mutation_started: false,
    cleanup: "not-started",
  };
  try {
    let creation = await query(statements.create, [challenge]);
    if (!creation.ok) {
      const stale = await query(statements.read);
      const staleRows = resultRows(stale.document);
      if (
        !stale.ok ||
        staleRows.length !== 1 ||
        staleRows[0]?.owner !== challenge
      ) {
        return outcome;
      }
      outcome = {
        ok: false,
        mutation_started: true,
        cleanup: "pending",
      };
      const staleDrop = await query(statements.drop);
      outcome.cleanup = staleDrop.ok ? "complete" : "failed";
      if (!staleDrop.ok) return outcome;
      creation = await query(statements.create, [challenge]);
      if (!creation.ok) return outcome;
    }
    created = true;
    outcome = {
      ok: false,
      mutation_started: true,
      cleanup: "pending",
    };
    const read = await query(statements.read);
    const rows = resultRows(read.document);
    outcome.ok =
      read.ok &&
      rows.length === 1 &&
      rows[0]?.owner === challenge;
  } catch {
    outcome.ok = false;
  } finally {
    if (created) {
      try {
        const dropped = await query(statements.drop);
        outcome.cleanup = dropped.ok ? "complete" : "failed";
      } catch {
        outcome.cleanup = "failed";
      }
    }
  }
  outcome.ok = outcome.ok && outcome.cleanup === "complete";
  return outcome;
}

function resultRows(document) {
  return Array.isArray(document?.result)
    ? document.result.flatMap((entry) =>
        Array.isArray(entry?.results) ? entry.results : [])
    : [];
}
