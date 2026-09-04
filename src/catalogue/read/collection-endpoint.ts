import { collectionRevisionStatement } from "./collection-revision-repository";
import { ifNoneMatchMatches } from "../../http/conditional-request";
import { type PublicBase, publicUrl } from "../../http/public-base";
import { canonicalJson, sha256Text } from "../shared";

export class ReadProblem extends Error {
  readonly detail: string;
  readonly title: string;
  readonly extensions: Record<string, unknown>;
  constructor(
    readonly status: number,
    readonly code: string,
    detail: string,
    readonly invalidParameter: { name: string; reason: string } | null = null,
    options: { headers?: HeadersInit; extensions?: Record<string, unknown> } = {},
  ) {
    super(detail);
    this.detail = detail;
    this.title = code
      .split("_")
      .map((word, index) => (index === 0 ? word[0]!.toUpperCase() + word.slice(1) : word))
      .join(" ");
    this.headers = options.headers ?? {};
    this.extensions = {
      ...(invalidParameter === null ? {} : { invalid_params: [invalidParameter] }),
      ...options.extensions,
    };
  }
  readonly headers: HeadersInit;
}

export function invalidParameter(name: string, reason: string): ReadProblem {
  return new ReadProblem(400, "invalid_parameter", reason, { name, reason });
}

export function collectionLimit(value: string | null): number {
  if (value === null) return 50;
  if (!/^[1-9][0-9]*$/u.test(value) || Number(value) > 100) {
    throw invalidParameter("limit", "limit must be an integer from 1 to 100.");
  }
  return Number(value);
}

export function singleParameter(url: URL, name: string): string | null {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) throw invalidParameter(name, `${name} must be supplied exactly once.`);
  return values[0] ?? null;
}

export function collectionParameters(url: URL, allowed?: readonly string[]): void {
  for (const name of url.searchParams.keys()) {
    if (name.length === 0) throw invalidParameter("query", "query parameter names must be non-empty.");
    if (allowed !== undefined && !allowed.includes(name)) throw invalidParameter(name, `${name} is not accepted.`);
    singleParameter(url, name);
  }
}

export function collectionFilter(url: URL, name: string): string | null {
  return collectionFilterValue(singleParameter(url, name), name);
}

export function collectionFilterValue(value: string | null, name: string): string | null {
  if (value !== null && value.length === 0)
    throw invalidParameter(name, `${name} must contain at least one character.`);
  if (value !== null && [...value].length > 500)
    throw invalidParameter(name, `${name} must contain at most 500 characters.`);
  return value;
}

export function encodeCursor(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function decodeCursor(value: string): unknown {
  try {
    if (value.length > 16384 || !/^[A-Za-z0-9+/_-]+={0,2}$/u.test(value)) throw new Error("invalid encoding");
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid shape");
    return parsed;
  } catch {
    throw new ReadProblem(400, "invalid_cursor", "The collection cursor is invalid.");
  }
}

export async function pinRevision(
  database: D1Database,
  cursorRevision: string | null,
  route: string,
  base: PublicBase,
  options: { search?: boolean; projection?: boolean } = {},
): Promise<{ id: string; published_at: string }> {
  const revision = await collectionRevisionStatement(database, cursorRevision, options).first<{
    id: string;
    published_at: string;
  }>();
  if (revision !== null) return revision;
  if (cursorRevision !== null) {
    throw new ReadProblem(409, "cursor_revision_unavailable", "The cursor Catalogue Revision is unavailable.", null, {
      extensions: { links: { collection: publicUrl(base, route) } },
    });
  }
  throw new ReadProblem(
    503,
    "catalogue_query_unavailable",
    "The current Catalogue Revision query projection is unavailable.",
  );
}

// Callers bind limit + 1; one extra row indicates a following page without
// issuing a count query. Card reads retain their additional byte budget.
export async function collectionPage<T>(
  statement: D1PreparedStatement,
  limit: number,
): Promise<{ rows: T[]; hasMore: boolean }> {
  const result = await statement.all<T>();
  return { rows: result.results.slice(0, limit), hasMore: result.results.length > limit };
}

export async function canonicalEtag(value: unknown): Promise<string> {
  return `"${await sha256Text(canonicalJson(value))}"`;
}

export function revisionHeaders(revisionId: string, etag: string): Record<string, string> {
  return { "cache-control": "private, no-cache", etag, "x-catalogue-revision": revisionId };
}

export function conditionalResponse(request: Request, headers: Record<string, string>): Response | null {
  return ifNoneMatchMatches(request, headers.etag!) ? new Response(null, { status: 304, headers }) : null;
}

export function collectionSelf(route: string, filters: Record<string, string | number | null>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== null && !(key === "limit" && value === 50)) query.set(key, String(value));
  }
  return query.size === 0 ? route : `${route}?${query}`;
}
