import { administrationPresentation } from "../../src/http/administration-presentation.mjs";
import { exitCodeForStatus, runtimeUrl } from "../command-support.mjs";
import { request } from "./http-client.mjs";

/** Default request deadline; commands with larger reads pass their own. */
export const defaultTimeoutMilliseconds = 10_000;
const timeoutPattern = /^[1-9]\d{0,8}$/u;

/**
 * The effective deadline: an explicit command option, else KEEPR_TIMEOUT_MS,
 * else the command's default. Returns null for a malformed override.
 */
export function requestTimeout(environment, option, commandDefault = defaultTimeoutMilliseconds) {
  const value = option ?? environment.KEEPR_TIMEOUT_MS;
  if (value === undefined || value === "") return commandDefault;
  return timeoutPattern.test(String(value)) ? Number(value) : null;
}

/** JSON transport and Problem-to-exit mapping; commands supply only I/O choices. */
export async function requestDocument(
  environment,
  pathname,
  {
    runtime = "ingestion",
    key = environment.KEEPR_ADMINISTRATION_KEY,
    method = "GET",
    body,
    present = false,
    contract = "administration",
    timeoutMs = requestTimeout(environment),
  } = {},
) {
  const label = runtime === "api" ? "API" : "ingestion";
  const prefix = environment.KEEPR_TARGET ? `KEEPR_${environment.KEEPR_TARGET.toUpperCase()}_` : "KEEPR_";
  const keyName = `${prefix}${runtime === "api" ? "API_KEY" : "ADMINISTRATION_KEY"}`;
  const failure = (error, exitCode) => ({ error, exitCode, document: null });
  if (!key) return failure({ code: "configuration_error", detail: `Missing required environment: ${keyName}` }, 2);
  if (timeoutMs === null)
    return failure(
      { code: "configuration_error", detail: "The request timeout must be a positive integer of milliseconds." },
      2,
    );
  const signal = AbortSignal.timeout(timeoutMs);
  const started = performance.now();
  // A deadline names the endpoint and elapsed time, whether it expired while
  // connecting, waiting for headers or reading the body.
  const timedOut = () =>
    failure(
      {
        code: "runtime_timeout",
        detail: `${label} runtime did not answer ${method} ${pathname.split("?")[0]} within ${timeoutMs} ms (elapsed ${Math.round(
          performance.now() - started,
        )} ms); raise --timeout-ms or KEEPR_TIMEOUT_MS`,
        runtime,
      },
      9,
    );
  let response;
  try {
    const base =
      runtime === "api"
        ? (environment.KEEPR_API_URL ?? "http://127.0.0.1:8787")
        : (environment.KEEPR_INGESTION_URL ?? "http://127.0.0.1:8788");
    response = await request(runtimeUrl(base, pathname), {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(environment.KEEPR_TEST_NOW === undefined ? {} : { "x-keepr-test-now": environment.KEEPR_TEST_NOW }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    });
  } catch {
    if (signal.aborted) return timedOut();
    return failure({ code: "runtime_unavailable", detail: `${label} runtime is unavailable`, runtime }, 9);
  }
  let document;
  try {
    document = await response.json();
  } catch {
    if (signal.aborted) return timedOut();
    return failure(
      { code: `invalid_${contract}_contract`, detail: `${label} runtime returned invalid JSON`, runtime },
      8,
    );
  }
  if (!response.ok)
    return failure(
      {
        code: typeof document?.code === "string" ? document.code : `${contract}_error`,
        detail:
          typeof document?.detail === "string" ? document.detail : `${label} runtime returned HTTP ${response.status}`,
      },
      exitCodeForStatus(response.status),
    );
  if (document === null || typeof document !== "object" || Array.isArray(document))
    return failure(
      { code: `invalid_${contract}_contract`, detail: `${label} runtime returned a non-object document`, runtime },
      8,
    );
  return {
    error: null,
    exitCode: 0,
    responseStatus: response.status,
    presentation: present ? administrationPresentation(document, response.status) : null,
    document,
  };
}
