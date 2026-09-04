/** Wire-safe release identities shared by server validation and workflow decoding. */
export const isReleaseIdentity = (value) =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:@|-]{0,255}$/u.test(value);
export const isReleaseDigest = (value) => typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
export const isReleaseHead = (value) => typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
export const isReleaseActor = (value) =>
  typeof value === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\[bot\]$/u.test(value);
