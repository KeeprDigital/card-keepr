import { exitCodeForStatus, runtimeUrl } from "../command-support.mjs";
import { request } from "./http-client.mjs";

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
  } = {},
) {
  const label = runtime === "api" ? "API" : "ingestion";
  const prefix = environment.KEEPR_TARGET ? `KEEPR_${environment.KEEPR_TARGET.toUpperCase()}_` : "KEEPR_";
  const keyName = `${prefix}${runtime === "api" ? "API_KEY" : "ADMINISTRATION_KEY"}`;
  const failure = (error, exitCode) => ({ error, exitCode, document: null });
  if (!key) return failure({ code: "configuration_error", detail: `Missing required environment: ${keyName}` }, 2);
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
        ...(present ? { accept: "application/vnd.card-keepr.cli+json" } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(environment.KEEPR_TEST_NOW === undefined ? {} : { "x-keepr-test-now": environment.KEEPR_TEST_NOW }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return failure({ code: "runtime_unavailable", detail: `${label} runtime is unavailable`, runtime }, 9);
  }
  let document;
  try {
    document = await response.json();
  } catch {
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
  if (
    present &&
    (document?.contract !== "card-keepr-cli-presentation@1" ||
      typeof document.text !== "string" ||
      ![0, 10].includes(document.exit_code))
  )
    return failure(
      { code: `invalid_${contract}_contract`, detail: `${label} runtime returned invalid presentation`, runtime },
      8,
    );
  return {
    error: null,
    exitCode: 0,
    responseStatus: response.status,
    presentation: present ? document : null,
    document: present ? document.document : document,
  };
}
