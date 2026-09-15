import { exitCodeForStatus, parseOptions, runtimeUrl, writeCliFailure } from "./command-support.mjs";
import { request } from "./lib/http-client.mjs";

/** The owner downloads one self-contained page; its browser needs no bearer session. */
export async function runDocumentationCommand(kind, arguments_, environment, json) {
  if (parseOptions(arguments_, []).error !== null)
    return writeCliFailure(json, { code: "usage_error", detail: `Usage: keepr docs ${kind} [--json]` }, 2);
  const owner = kind === "administration";
  if (owner && !environment.KEEPR_ADMINISTRATION_KEY)
    return writeCliFailure(json, { code: "configuration_error", detail: "KEEPR_ADMINISTRATION_KEY is required." }, 2);
  const base = owner
    ? (environment.KEEPR_INGESTION_URL ?? "http://127.0.0.1:8788")
    : (environment.KEEPR_API_URL ?? "http://127.0.0.1:8787");
  try {
    const media = json ? "application/json" : "text/html";
    const response = await request(runtimeUrl(base, json ? "/openapi.json" : "/docs"), {
      headers: {
        accept: media,
        ...(owner ? { authorization: `Bearer ${environment.KEEPR_ADMINISTRATION_KEY}` } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status !== 200)
      return writeCliFailure(
        json,
        { code: `http_${response.status}`, detail: `Documentation request returned HTTP ${response.status}.` },
        exitCodeForStatus(response.status),
      );
    if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== media)
      return writeCliFailure(json, { code: "invalid_response", detail: "Unexpected documentation media type." }, 9);
    const body = await response.text();
    if (json && JSON.parse(body)?.openapi !== "3.1.0")
      return writeCliFailure(json, { code: "invalid_response", detail: "Expected an OpenAPI 3.1 document." }, 9);
    process.stdout.write(body);
    return 0;
  } catch {
    return writeCliFailure(json, { code: "documentation_unavailable", detail: "Could not download documentation." }, 9);
  }
}
