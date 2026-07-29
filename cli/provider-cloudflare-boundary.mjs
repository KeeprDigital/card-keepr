import {
  classifyTokenLookup,
  cloudflareOperationSucceeded,
  d1DatabaseInfoSucceeded,
  exactTokenPolicy,
} from "./provider-authority.mjs";

export function createCloudflareProvider({
  accountId,
  resourceIdentity,
}) {
  async function request(token, pathname, init = {}) {
    return fetch(`https://api.cloudflare.com/client/v4${pathname}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
  }

  async function tokenDetails(managementCredential, tokenId) {
    let response;
    try {
      response = await request(
        managementCredential,
        `/accounts/${accountId}/tokens/${encodeURIComponent(tokenId)}`,
      );
    } catch {
      return { kind: "failure" };
    }
    return classifyTokenLookup(response, tokenId);
  }

  async function verifyToken(token) {
    let response;
    try {
      response = await request(
        token,
        `/accounts/${accountId}/tokens/verify`,
      );
    } catch {
      return null;
    }
    if (!response.ok) return null;
    const document = await safeJson(response);
    return document?.success === true ? document.result : null;
  }

  async function deleteIssuerCredential(
    managementCredential,
    tokenId,
    permission,
  ) {
    const existing = await tokenDetails(
      managementCredential,
      tokenId,
    );
    if (existing.kind === "absent") return true;
    if (
      existing.kind !== "present" ||
      !exactTokenPolicy(
        existing.token,
        permission,
        accountId,
      )
    ) {
      return false;
    }
    let response;
    try {
      response = await request(
        managementCredential,
        `/accounts/${accountId}/tokens/${encodeURIComponent(tokenId)}`,
        { method: "DELETE" },
      );
    } catch {
      return false;
    }
    if (!response.ok) return false;
    const document = await safeJson(response);
    return document?.success === true;
  }

  async function probeExactCapability(credentialClass, token) {
    const databaseId = d1DatabaseId(resourceIdentity);
    if (credentialClass === "d1_export_token") {
      const response = await request(
        token,
        `/accounts/${accountId}/d1/database/${databaseId}`,
      );
      return d1DatabaseInfoSucceeded(response, databaseId);
    }
    if (credentialClass === "d1_verification_token") {
      const response = await request(
        token,
        `/accounts/${accountId}/d1/database/${databaseId}/query`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sql: [
              "CREATE TABLE IF NOT EXISTS __keepr_credential_probe (id INTEGER PRIMARY KEY)",
              "DROP TABLE __keepr_credential_probe",
            ].join(";"),
          }),
        },
      );
      return cloudflareOperationSucceeded(response);
    }
    return credentialClass === "github_deployment_token";
  }

  return {
    deleteIssuerCredential,
    probeExactCapability,
    request,
    tokenDetails,
    verifyToken,
  };
}

function d1DatabaseId(resourceIdentity) {
  return resourceIdentity.slice(
    resourceIdentity.lastIndexOf(":") + 1,
  );
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
