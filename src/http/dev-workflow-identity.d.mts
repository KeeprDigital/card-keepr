export const devAudience: string;
export const stagingAudience: string;
export function verifyStagingWorkflow(
  token: string,
  githubToken: string,
  intent: Record<string, unknown>,
  now?: number,
  requireCi?: boolean,
): Promise<{ headSha: string; runId: string; runAttempt: string; tokenId: string; expiresAt: string }>;
export const requiredCiChecks: string[];
export function verifyDevWorkflow(
  token: string,
  githubToken: string,
  intent: Record<string, unknown>,
  now?: number,
): Promise<{ headSha: string; runId: string; runAttempt: string; tokenId: string; expiresAt: string }>;

export function verifyDevCommit(githubToken: string, intent: Record<string, unknown>): Promise<string>;
export function verifyReleaseCommit(githubToken: string, intent: Record<string, unknown>): Promise<string>;
