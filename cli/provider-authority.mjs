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
  return (
    !Array.isArray(document.result) ||
    document.result.every(
      (result) =>
        result !== null &&
        typeof result === "object" &&
        result.success === true,
    )
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

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
