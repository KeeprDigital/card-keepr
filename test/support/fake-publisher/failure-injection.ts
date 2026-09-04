import type { PublisherRequest } from "./scenario.ts";

// Failure injection is stateful only for bounded outages ("fail N times, then
// recover"). That state is scoped to the request identity a test controls —
// the hostname it invents, the path it fetches, and the user-agent marker it
// sends — rather than to the process, so concurrently running test files
// never see each other's attempt counts and the workers-pool concurrency cap
// no longer has to serialise them.
export interface FailureInjection {
  // Records one more attempt for the request's scope and returns the count,
  // starting at 1.
  attempt(request: Request): number;
}

export function failureInjectionScope(request: Request): string {
  const url = new URL(request.url);
  const marker = request.headers.get("user-agent")
    ?.replace(/;\s*request-(?:role|surface)=[^;]*(?=;|$)/gu, "") ?? "";
  return `${url.hostname}${url.pathname}${url.search}|${marker}`;
}

export function createFailureInjection(): FailureInjection {
  const attempts = new Map<string, number>();
  return {
    attempt(request) {
      const scope = failureInjectionScope(request);
      const count = (attempts.get(scope) ?? 0) + 1;
      attempts.set(scope, count);
      return count;
    },
  };
}

function unavailable(retryAfter: string): Response {
  return new Response("temporarily unavailable", {
    status: 503,
    headers: { "retry-after": retryAfter },
  });
}

// The acceptance suites select a transport outcome through the user-agent
// they send with the request; the outcome applies to every hostname.
export const acceptanceTransportUserAgentPrefix =
  "card-keepr-acceptance-transport/";

export function transportOutcomeForUserAgent(
  context: PublisherRequest,
  options: { readonly redirectLocation: string },
): Response | null {
  const userAgent = context.request.headers.get("user-agent");
  if (userAgent === `${acceptanceTransportUserAgentPrefix}redirect`) {
    return new Response(null, {
      status: 302,
      headers: { location: options.redirectLocation },
    });
  }
  if (userAgent === `${acceptanceTransportUserAgentPrefix}unavailable`) {
    return unavailable("0");
  }
  if (
    userAgent ===
      `${acceptanceTransportUserAgentPrefix}unavailable-then-recovered` &&
    context.failures.attempt(context.request) <= 4
  ) {
    return unavailable("0");
  }
  // Recovered, or no transport outcome requested: fall through to the normal
  // fixture response.
  return null;
}

// The workers-pool suites select a transport outcome through the path they
// fetch on a synthetic hostname of their own.
export function transportOutcomeForPath(
  context: PublisherRequest,
  pathname: string,
  options: { readonly redirectLocation: string },
): Response | null {
  const { request, url } = context;
  if (pathname === "/redirect") {
    return new Response(null, {
      status: 302,
      headers: { location: options.redirectLocation },
    });
  }
  if (pathname === "/unavailable") return unavailable("0");
  if (pathname === "/conditional") {
    if (request.headers.get("if-none-match") === '"conditional-v1"') {
      return new Response(null, {
        status: 304,
        headers: { etag: '"conditional-v1"' },
      });
    }
    return new Response('{"cards":[{"card_number":"OP02-001"}]}', {
      headers: {
        "content-type": "application/json",
        etag: '"conditional-v1"',
        vary: "accept-language",
      },
    });
  }
  if (pathname === "/retry-after-long") return unavailable("120");
  if (pathname === "/unavailable-then-recovered") {
    if (context.failures.attempt(request) <= 4) return unavailable("0");
    return new Response(
      '{"cards":[{"card_number":"OP01-003","name":"Recovered Card"}]}',
      { headers: { "content-type": "application/json" } },
    );
  }
  if (pathname === "/retry-after-empty") return unavailable("");
  if (pathname === "/retry-once") {
    if (context.failures.attempt(request) === 1) return unavailable("2");
    return new Response(
      '{"cards":[{"card_number":"OP01-002","name":"Retry Card"}]}',
      { headers: { "content-type": "application/json" } },
    );
  }
  if (pathname === "/retry-once-slow") {
    // A first refusal whose Retry-After is long enough for a test to
    // terminate the sleeping hostname shard deterministically; every later
    // fetch succeeds.
    if (context.failures.attempt(request) === 1) return unavailable("30");
    return new Response(
      '{"cards":[{"card_number":"OP01-002","name":"Retry Card"}]}',
      { headers: { "content-type": "application/json" } },
    );
  }
  if (pathname === "/large-json") {
    const body = JSON.stringify({ padding: "x".repeat(1024 * 1024) });
    return new Response(body, {
      headers: {
        "content-length": String(new TextEncoder().encode(body).byteLength),
        "content-type": "application/json",
      },
    });
  }
  if (pathname === "/oversized-chunked-json") {
    let chunks = 0;
    return new Response(
      new ReadableStream({
        pull(controller) {
          if (chunks === 5) {
            controller.close();
            return;
          }
          controller.enqueue(new Uint8Array(256 * 1024).fill(120));
          chunks += 1;
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  }
  if (pathname === "/huge-json") {
    return new Response(
      JSON.stringify({ padding: "x".repeat(33 * 1024 * 1024) }),
      { headers: { "content-type": "application/json" } },
    );
  }
  if (pathname === "/body-failure") {
    return new Response('{"cards":[]}', {
      headers: {
        "content-length": "invalid",
        "content-type": "application/json",
      },
    });
  }
  if (pathname.startsWith("/sequence/")) {
    return new Response(
      `{"cards":[{"sequence":"${url.hostname}${pathname}"}]}`,
      { headers: { "content-type": "application/json" } },
    );
  }
  if (pathname === "/invalid-json") {
    return new Response("<html>not JSON</html>", {
      headers: { "content-type": "text/html" },
    });
  }
  return null;
}
