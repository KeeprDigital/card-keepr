export function cloudflareJson(response: Response): Promise<unknown>;

export function verifyCloudflareEnvelope(document: unknown): boolean;

export function verifyD1DatabaseMetadata(
  document: unknown,
  databaseId: string,
): boolean;

export function disposableProbeStatements(
  planDigest: string,
  challenge: string,
): Readonly<{
  table: string;
  create: string;
  read: string;
  drop: string;
}>;

export function probeD1Credential(input: {
  request: (
    pathname: string,
    init?: RequestInit,
  ) => Promise<Response>;
  accountId: string;
  databaseId: string;
  permission: string;
  planDigest: string;
  challenge: string;
}): Promise<{
  ok: boolean;
  mutation_started: boolean;
  cleanup: string;
}>;
