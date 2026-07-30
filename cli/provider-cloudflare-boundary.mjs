import {
  classifyTokenLookup,
  exactTokenPolicy,
} from "./provider-authority.mjs";
import {
  cloudflareJson,
  probeD1Credential,
} from "../src/credentials/cloudflare-authority.mjs";

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
    const document = await cloudflareJson(response);
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
    const document = await cloudflareJson(response);
    return document?.success === true;
  }

  async function probeExactCapability(
    credentialClass,
    token,
    planDigest,
    challenge,
  ) {
    const databaseId = d1DatabaseId(resourceIdentity);
    if (
      credentialClass === "d1_export_token" ||
      credentialClass === "d1_verification_token"
    ) {
      return probeD1Credential({
        request: (pathname, init) => request(token, pathname, init),
        accountId,
        databaseId,
        permission:
          credentialClass === "d1_export_token"
            ? "D1 Read"
            : "D1 Edit",
        planDigest,
        challenge,
      });
    }
    return {
      ok: credentialClass === "github_deployment_token",
      mutation_started: false,
      cleanup: "not-applicable",
    };
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
