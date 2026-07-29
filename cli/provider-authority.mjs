export async function classifyTokenLookup(response, tokenId) {
  const document = await safeJson(response);
  if (response.status === 404) {
    return document?.success === false
      ? { kind: "absent" }
      : { kind: "failure" };
  }
  if (!response.ok) return { kind: "failure" };
  return document?.success === true &&
    document.result?.id === tokenId &&
    document.result?.status === "active"
    ? { kind: "present", token: document.result }
    : { kind: "failure" };
}

export async function cloudflareOperationSucceeded(response) {
  if (!response.ok) return false;
  const document = await safeJson(response);
  if (document?.success !== true) return false;
  const results = Array.isArray(document.result)
    ? document.result
    : [document.result];
  return results.every((result) => {
    if (result === null || typeof result !== "object") return true;
    if (result.success !== undefined && result.success !== true) {
      return false;
    }
    return result.status === undefined ||
      ["complete", "completed", "success"].includes(result.status);
  });
}

export async function d1DatabaseInfoSucceeded(
  response,
  databaseId,
) {
  if (!response.ok) return false;
  const document = await safeJson(response);
  return (
    document?.success === true &&
    document.result?.uuid === databaseId
  );
}

export function classifySecretList(result) {
  if (result.code !== 0) return { kind: "failure" };
  let listed;
  try {
    listed = JSON.parse(result.stdout);
  } catch {
    return { kind: "failure" };
  }
  if (!Array.isArray(listed)) return { kind: "failure" };
  const names = listed.map((item) => item?.name);
  return names.every((name) => typeof name === "string")
    ? { kind: "present", names }
    : { kind: "failure" };
}

export function exactTokenPolicy(
  token,
  permission,
  cloudflareAccountId,
) {
  if (!Array.isArray(token.policies) || token.policies.length !== 1) {
    return false;
  }
  const policy = token.policies[0];
  const groups = policy?.permission_groups;
  const resources = policy?.resources;
  if (
    resources === null ||
    typeof resources !== "object" ||
    Array.isArray(resources)
  ) {
    return false;
  }
  const entries = Object.entries(resources);
  return (
    policy?.effect === "allow" &&
    Array.isArray(groups) &&
    groups.length === 1 &&
    groups[0]?.name === permission &&
    entries.length === 1 &&
    entries[0][0] ===
      `com.cloudflare.api.account.${cloudflareAccountId}` &&
    entries[0][1] === "*"
  );
}

export function exactManagementTokenPolicy(
  token,
  permissions,
  cloudflareAccountId,
) {
  if (
    !Array.isArray(permissions) ||
    permissions.length === 0 ||
    !Array.isArray(token.policies) ||
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
  const actualPermissions = groups.map((group) => group?.name).sort();
  const expectedPermissions = [...permissions].sort();
  const entries = Object.entries(resources);
  return (
    actualPermissions.every(
      (permission, index) =>
        permission === expectedPermissions[index],
    ) &&
    entries.length === 1 &&
    entries[0][0] ===
      `com.cloudflare.api.account.${cloudflareAccountId}` &&
    entries[0][1] === "*"
  );
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
