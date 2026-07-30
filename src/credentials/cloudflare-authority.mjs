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

export function exactTokenPolicy(
  token,
  permission,
  cloudflareAccountId,
) {
  return exactAccountTokenPolicy(
    token,
    [permission],
    cloudflareAccountId,
  );
}

export function exactManagementTokenPolicy(
  token,
  permissions,
  cloudflareAccountId,
) {
  return (
    Array.isArray(permissions) &&
    permissions.length > 0 &&
    permissions.every(
      (permission) => typeof permission === "string",
    ) &&
    exactAccountTokenPolicy(
      token,
      permissions,
      cloudflareAccountId,
    )
  );
}

function exactAccountTokenPolicy(
  token,
  permissions,
  cloudflareAccountId,
) {
  if (
    !Array.isArray(token?.policies) ||
    token.policies.length !== 1
  ) {
    return false;
  }
  const policy = token.policies[0];
  const groups = policy?.permission_groups;
  const resources = policy?.resources;
  if (
    policy?.effect !== "allow" ||
    !Array.isArray(groups) ||
    groups.length !== permissions.length ||
    resources === null ||
    typeof resources !== "object" ||
    Array.isArray(resources)
  ) {
    return false;
  }
  const actual = groups.map((group) => group?.name).sort();
  const expected = [...permissions].sort();
  const entries = Object.entries(resources);
  return (
    actual.every(
      (permission, index) => permission === expected[index],
    ) &&
    entries.length === 1 &&
    entries[0][0] ===
      `com.cloudflare.api.account.${cloudflareAccountId}` &&
    entries[0][1] === "*"
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
    inspect:
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?",
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
  if (permission !== "D1 Write") {
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
  const tableIsAbsent = async () => {
    try {
      const inspected = await query(
        statements.inspect,
        [statements.table],
      );
      const rows = resultRows(inspected.document);
      return inspected.ok &&
        rows !== null &&
        rows.length === 0;
    } catch {
      return false;
    }
  };
  const dropOwnedTable = async () => {
    outcome.mutation_started = true;
    outcome.cleanup = "pending";
    try {
      const dropped = await query(statements.drop);
      if (dropped.ok) {
        outcome.cleanup = "complete";
        return true;
      }
    } catch {
      // The provider may have applied the DROP before losing its response.
    }
    const absent = await tableIsAbsent();
    outcome.cleanup = absent ? "complete" : "failed";
    return absent;
  };
  const cleanupExactOwnedTable = async () => {
    outcome.mutation_started = true;
    outcome.cleanup = "pending";
    let observed;
    try {
      observed = await query(statements.read);
    } catch {
      outcome.cleanup = "failed";
      return false;
    }
    const rows = resultRows(observed.document);
    if (
      !observed.ok ||
      rows === null ||
      rows.length !== 1 ||
      rows[0]?.owner !== challenge
    ) {
      outcome.cleanup = "failed";
      return false;
    }
    return dropOwnedTable();
  };
  const createOwnedTable = async () => {
    outcome.mutation_started = true;
    outcome.cleanup = "pending";
    try {
      return {
        kind: "response",
        result: await query(statements.create, [challenge]),
      };
    } catch {
      await cleanupExactOwnedTable();
      return { kind: "ambiguous" };
    }
  };

  let creation = await createOwnedTable();
  if (creation.kind === "ambiguous") return outcome;
  if (!creation.result.ok) {
    if (!(await cleanupExactOwnedTable())) return outcome;
    creation = await createOwnedTable();
    if (
      creation.kind === "ambiguous" ||
      !creation.result.ok
    ) {
      if (creation.kind === "response") {
        await cleanupExactOwnedTable();
      }
      return outcome;
    }
  }
  created = true;
  try {
    const read = await query(statements.read);
    const rows = resultRows(read.document);
    outcome.ok =
      read.ok &&
      rows !== null &&
      rows.length === 1 &&
      rows[0]?.owner === challenge;
  } catch {
    outcome.ok = false;
  } finally {
    if (created) {
      await dropOwnedTable();
    }
  }
  outcome.ok = outcome.ok && outcome.cleanup === "complete";
  return outcome;
}

function resultRows(document) {
  if (
    !Array.isArray(document?.result) ||
    document.result.length === 0 ||
    !document.result.every((entry) =>
      Array.isArray(entry?.results))
  ) {
    return null;
  }
  return document.result.flatMap((entry) => entry.results);
}
