import { readFile } from "node:fs/promises";
import {
  exitCodeForStatus,
  parseOptions,
  writeCliFailure,
} from "./command-support.mjs";

export async function runCuratedRevisionCommand(arguments_, environment, json) {
  const operation = arguments_[0];
  if (operation === "validate") return validate(arguments_.slice(1), environment, json);
  if (operation === "list") return list(arguments_.slice(1), environment, json);
  if (operation === "show") return show(arguments_.slice(1), environment, json);
  if (operation === "create") return create(arguments_.slice(1), environment, json);
  return usage(json);
}

async function validate(arguments_, environment, json) {
  const options = parseOptions(arguments_, ["--proposal", "--expected-current-revision"]);
  const proposalFile = options.values["--proposal"];
  const expected = options.values["--expected-current-revision"];
  if (options.error !== null || proposalFile === undefined || expected === undefined) return usage(json);
  const proposal = await readProposal(proposalFile, json);
  if (proposal.error !== null) return proposal.error;
  return request(environment, json, "/admin/v1/curated-revisions/validate", "POST", {
    proposal: proposal.value,
    expected_current_revision_id: expected,
  });
}

async function list(arguments_, environment, json) {
  const options = parseOptions(arguments_, ["--game", "--target", "--status"]);
  if (options.error !== null) return usage(json);
  const query = new URLSearchParams();
  for (const [option, parameter] of [["--game", "game"], ["--target", "target"], ["--status", "status"]]) {
    const value = options.values[option];
    if (value !== undefined) query.set(parameter, value);
  }
  return request(environment, json, `/admin/v1/curated-revisions${query.size === 0 ? "" : `?${query}`}`, "GET");
}

async function show(arguments_, environment, json) {
  const options = parseOptions(arguments_, ["--revision-id"]);
  const id = options.values["--revision-id"];
  if (options.error !== null || id === undefined) return usage(json);
  return request(environment, json, `/admin/v1/curated-revisions/${encodeURIComponent(id)}`, "GET");
}

async function create(arguments_, environment, json) {
  const options = parseOptions(arguments_, [
    "--proposal", "--proposal-digest", "--expected-current-revision", "--idempotency-key",
  ], ["--yes"]);
  const proposalFile = options.values["--proposal"];
  const digest = options.values["--proposal-digest"];
  const expected = options.values["--expected-current-revision"];
  const idempotencyKey = options.values["--idempotency-key"];
  if (options.error !== null || proposalFile === undefined || digest === undefined || expected === undefined || idempotencyKey === undefined || !options.flags.has("--yes")) return usage(json);
  const proposal = await readProposal(proposalFile, json);
  if (proposal.error !== null) return proposal.error;
  return request(environment, json, "/admin/v1/curated-revisions", "POST", {
    environment: "production",
    expected_current_revision_id: expected,
    proposal: proposal.value,
    proposal_digest: digest,
    idempotency_key: idempotencyKey,
  });
}

async function readProposal(path, json) {
  try {
    const text = path === "-" ? await stdinText() : await readFile(path, "utf8");
    const value = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return { error: null, value };
  } catch {
    return {
      error: writeCliFailure(json, {
        code: "invalid_proposal_file",
        detail: "The proposal file or stdin must contain one JSON object.",
      }, 8),
      value: null,
    };
  }
}

async function request(environment, json, pathname, method, body) {
  if (!environment.KEEPR_ADMINISTRATION_KEY) {
    return writeCliFailure(json, { code: "configuration_error", detail: "Missing required environment: KEEPR_ADMINISTRATION_KEY" }, 2);
  }
  let response;
  try {
    response = await fetch(new URL(pathname, environment.KEEPR_INGESTION_URL ?? "http://127.0.0.1:8788"), {
      method,
      headers: {
        authorization: `Bearer ${environment.KEEPR_ADMINISTRATION_KEY}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(environment.KEEPR_TEST_NOW === undefined ? {} : { "x-keepr-test-now": environment.KEEPR_TEST_NOW }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return writeCliFailure(json, { code: "runtime_unavailable", detail: "ingestion runtime is unavailable", runtime: "ingestion" }, 9);
  }
  let document;
  try { document = await response.json(); }
  catch { return writeCliFailure(json, { code: "invalid_administration_contract", detail: "ingestion runtime returned invalid JSON", runtime: "ingestion" }, 8); }
  if (!response.ok) {
    return writeCliFailure(json, {
      code: typeof document?.code === "string" ? document.code : "administration_error",
      detail: typeof document?.detail === "string" ? document.detail : `ingestion runtime returned HTTP ${response.status}`,
    }, exitCodeForStatus(response.status));
  }
  process.stdout.write(json ? `${JSON.stringify(document)}\n` : `${format(document)}\n`);
  return 0;
}

function format(document) {
  if (document.contract === "card-keepr-curated-revision-list@1") {
    const revisions = Array.isArray(document.revisions) ? document.revisions : [];
    return revisions.length === 0 ? "No Curated Revisions" : revisions.map((revision) => `${revision.id} ${revision.game} ${revision.status} ${revision.content_digest}`).join("\n");
  }
  if (document.contract === "card-keepr-curated-revision-validation@1") return `Valid Curated Revision proposal ${document.proposal_digest}`;
  return `Curated Revision ${document.id}: ${document.status} (${document.content_digest ?? "digest unavailable"})`;
}

function stdinText() {
  return new Promise((resolve, reject) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { text += chunk; });
    process.stdin.once("end", () => resolve(text));
    process.stdin.once("error", reject);
  });
}

function usage(json) {
  return writeCliFailure(json, {
    code: "usage_error",
    detail: "Usage: keepr curated-revision validate|list|show|create [options] [--json]",
  }, 2);
}
