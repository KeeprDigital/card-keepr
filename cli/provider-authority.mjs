import {
  cloudflareJson,
  exactManagementTokenPolicy,
  exactTokenPolicy,
  verifyCloudflareEnvelope,
  verifyD1DatabaseMetadata,
} from "../src/credentials/cloudflare-authority.mjs";

export {
  exactManagementTokenPolicy,
  exactTokenPolicy,
};

export async function classifyTokenLookup(response, tokenId) {
  const document = await cloudflareJson(response);
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
  return verifyCloudflareEnvelope(await cloudflareJson(response));
}

export async function d1DatabaseInfoSucceeded(
  response,
  databaseId,
) {
  if (!response.ok) return false;
  return verifyD1DatabaseMetadata(
    await cloudflareJson(response),
    databaseId,
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
