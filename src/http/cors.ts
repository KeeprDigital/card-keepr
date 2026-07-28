const allowedMethods = ["GET", "HEAD", "OPTIONS"];

export function allowedPreflightResponse(
  request: Request,
  configuredOrigins: string,
): Response | null {
  if (request.method !== "OPTIONS") return null;

  const origin = request.headers.get("origin");
  const requestedMethod = request.headers.get("access-control-request-method");
  const requestedHeaders = request.headers
    .get("access-control-request-headers")
    ?.split(",")
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean);
  const origins = configuredOrigins
    .split(",")
    .map((candidate) => candidate.trim())
    .filter(Boolean);

  if (
    origin === null ||
    !origins.includes(origin) ||
    requestedMethod === null ||
    !allowedMethods.includes(requestedMethod.toUpperCase()) ||
    requestedHeaders?.some((header) => header !== "authorization")
  ) {
    return null;
  }

  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": allowedMethods.join(", "),
      "access-control-allow-headers": "Authorization",
      vary: "Origin",
    },
  });
}

export function hasAllowedOrigin(
  request: Request,
  configuredOrigins: string,
): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  return configuredOrigins
    .split(",")
    .map((candidate) => candidate.trim())
    .filter(Boolean)
    .includes(origin);
}

export function withCorsHeaders(request: Request, response: Response): Response {
  const origin = request.headers.get("origin");
  if (origin === null) return response;

  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set(
    "access-control-expose-headers",
    "ETag, X-Catalogue-Revision",
  );
  headers.append("vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
