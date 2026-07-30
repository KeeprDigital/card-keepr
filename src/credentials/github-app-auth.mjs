import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";

export function createGithubAppJwt(
  privateKey,
  appId,
  observedAt,
) {
  if (
    typeof privateKey !== "string" ||
    !privateKey.includes("PRIVATE KEY-----") ||
    !/^[1-9][0-9]*$/.test(appId ?? "")
  ) {
    return null;
  }
  const observed = new Date(observedAt);
  if (
    !Number.isFinite(observed.valueOf()) ||
    observed.toISOString() !== observedAt
  ) {
    return null;
  }
  try {
    const now = Math.floor(observed.valueOf() / 1000);
    const header = base64Url(JSON.stringify({
      alg: "RS256",
      typ: "JWT",
    }));
    const payload = base64Url(JSON.stringify({
      iat: now - 60,
      exp: now + 600,
      iss: appId,
    }));
    const signingInput = `${header}.${payload}`;
    const signature = sign(
      "RSA-SHA256",
      Buffer.from(signingInput),
      createPrivateKey(privateKey),
    ).toString("base64url");
    return `${signingInput}.${signature}`;
  } catch {
    return null;
  }
}

export function githubAppKeyFingerprint(privateKey) {
  try {
    const publicDer = createPublicKey(privateKey).export({
      type: "spki",
      format: "der",
    });
    const digest = createHash("sha256")
      .update(publicDer)
      .digest("hex");
    return `sha256:${digest}`;
  } catch {
    return null;
  }
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}
