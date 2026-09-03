// Public mount of one worker (issue #123, ADR 0007). Each worker owns a
// single PUBLIC_BASE_URL such as https://card.keepr.digital/api. Its path is
// the mount every inbound request must sit under, and the whole URL is the
// base every emitted link is built from. Only the path takes part in
// routing: a request that reaches the worker through another origin (local
// wrangler dev, the vitest pool) is still routed by path, so tests and local
// development mount at the root by overriding the var with a path-free base.

export type PublicBase = {
  readonly origin: string;
  /** The mount path without a trailing slash; "" for a root mount. */
  readonly basePath: string;
};

let cached: { value: string; base: PublicBase } | null = null;

export function publicBase(env: { PUBLIC_BASE_URL: string }): PublicBase {
  const value = env.PUBLIC_BASE_URL;
  if (cached !== null && cached.value === value) return cached.base;
  const base = parsePublicBase(value);
  cached = { value, base };
  return base;
}

export function parsePublicBase(value: unknown): PublicBase {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("PUBLIC_BASE_URL configuration is required");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PUBLIC_BASE_URL configuration is not an absolute URL");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error(
      "PUBLIC_BASE_URL configuration must be an http(s) origin plus an optional path",
    );
  }
  const basePath = url.pathname.replace(/\/+$/u, "");
  if (basePath.includes("//")) {
    throw new Error("PUBLIC_BASE_URL configuration path is invalid");
  }
  return { origin: url.origin, basePath };
}

/**
 * The request path with the mount stripped, or null when the request is not
 * under the mount. The exact mount (with or without a trailing slash) maps
 * to "/". A root mount ("") returns the pathname unchanged.
 */
export function routePath(url: URL, basePath: string): string | null {
  const pathname = url.pathname;
  if (basePath === "") return pathname;
  if (pathname === basePath || pathname === `${basePath}/`) return "/";
  if (pathname.startsWith(`${basePath}/`)) {
    return pathname.slice(basePath.length);
  }
  return null;
}

/** An absolute public URL for a worker-relative route path (query allowed). */
export function publicUrl(base: PublicBase, route: string): string {
  if (!route.startsWith("/")) {
    throw new Error(`Route path ${JSON.stringify(route)} must start with "/"`);
  }
  return `${base.origin}${base.basePath}${route}`;
}

/**
 * The same request re-addressed to its stripped route path, so every
 * downstream reader of request.url sees root-mounted paths.
 */
export function mountedRequest(request: Request, route: string): Request {
  const url = new URL(request.url);
  if (url.pathname === route) return request;
  url.pathname = route;
  return new Request(url, request);
}

/**
 * Stored catalogue documents carry root-relative "/v1/..." links (a Card's
 * self link, a Printing Image's content link). The API rewrites those to
 * absolute public URLs at read time, keeping storage host-independent. Only
 * string values of objects held under a "links" key are rewritten; every
 * other field is returned untouched.
 */
export function absoluteDocumentLinks<T>(value: T, base: PublicBase): T {
  return rewrite(value, base, false) as T;
}

function rewrite(value: unknown, base: PublicBase, inLinks: boolean): unknown {
  if (Array.isArray(value)) {
    return replaceIfChanged(
      value,
      value.map((item) => rewrite(item, base, false)),
    );
  }
  if (typeof value === "string") {
    return inLinks && value.startsWith("/v1/") ? publicUrl(base, value) : value;
  }
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    result[key] = inLinks
      ? typeof entry === "string" ? rewrite(entry, base, true) : entry
      : rewrite(entry, base, key === "links");
  }
  return replaceIfChanged(record, result);
}

function replaceIfChanged<T extends object>(
  original: T,
  candidate: T,
): T {
  const originalValues = Object.values(original);
  const candidateValues = Object.values(candidate);
  return originalValues.every((entry, index) => entry === candidateValues[index])
    ? original
    : candidate;
}
