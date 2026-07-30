export function createGithubAppJwt(
  privateKey: string,
  appId: string,
  observedAt: string,
): string | null;

export function githubAppKeyFingerprint(
  privateKey: string,
): string | null;
