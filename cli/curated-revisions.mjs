import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import {
  exitCodeForStatus,
  parseOptions,
  runtimeUrl,
  writeCliFailure,
} from "./command-support.mjs";
import { validatedProductionTarget } from "./production-target.mjs";

export async function runCuratedRevisionCommand(arguments_, environment, json) {
  const operation = arguments_[0];
  if (operation === "validate") return validate(arguments_.slice(1), environment, json);
  if (operation === "list") return list(arguments_.slice(1), environment, json);
  if (operation === "show") return show(arguments_.slice(1), environment, json);
  if (operation === "create") return create(arguments_.slice(1), environment, json);
  if (operation === "reaffirm") return lifecycle("reaffirm", arguments_.slice(1), environment, json);
  if (operation === "supersede") return lifecycle("supersede", arguments_.slice(1), environment, json);
  if (operation === "retire") return lifecycle("retire", arguments_.slice(1), environment, json);
  return usage(json);
}

async function validate(arguments_, environment, json) {
  const options = parseOptions(arguments_, ["--proposal", "--expected-current-revision", "--secrets-stdin-fd"]);
  const proposalFile = options.values["--proposal"];
  const expected = options.values["--expected-current-revision"];
  if (options.error !== null || proposalFile === undefined || expected === undefined) return usage(json);
  const proposal = await readProposal(proposalFile, json);
  if (proposal.error !== null) return proposal.error;
  const secret = requiredAdministrationSecret(options, json);
  if (typeof secret === "number") return secret;
  return request(environment, json, "/admin/v1/curated-revisions/validate", "POST", {
    proposal: proposal.value,
    catalogue_revision_id: expected,
  }, secret);
}

async function list(arguments_, environment, json) {
  const options = parseOptions(arguments_, ["--game", "--target", "--status", "--secrets-stdin-fd"]);
  if (options.error !== null) return usage(json);
  const secret = requiredAdministrationSecret(options, json);
  if (typeof secret === "number") return secret;
  const query = new URLSearchParams();
  for (const [option, parameter] of [["--game", "game"], ["--target", "target"], ["--status", "status"]]) {
    const value = options.values[option];
    if (value !== undefined) query.set(parameter, value);
  }
  return request(environment, json, `/admin/v1/curated-revisions${query.size === 0 ? "" : `?${query}`}`, "GET", undefined, secret);
}

async function show(arguments_, environment, json) {
  const options = parseOptions(arguments_, ["--revision-id", "--secrets-stdin-fd"]);
  const id = options.values["--revision-id"];
  if (options.error !== null || id === undefined) return usage(json);
  const secret = requiredAdministrationSecret(options, json);
  if (typeof secret === "number") return secret;
  return request(environment, json, `/admin/v1/curated-revisions/${encodeURIComponent(id)}`, "GET", undefined, secret);
}

async function create(arguments_, environment, json) {
  const options = parseOptions(arguments_, [
    "--proposal", "--proposal-digest", "--expected-current-revision", "--idempotency-key",
    "--environment", "--confirm", "--secrets-stdin-fd",
  ], ["--yes"]);
  const proposalFile = options.values["--proposal"];
  const digest = options.values["--proposal-digest"];
  const expected = options.values["--expected-current-revision"];
  const idempotencyKey = options.values["--idempotency-key"];
  if (options.error !== null || proposalFile === undefined || digest === undefined || expected === undefined || idempotencyKey === undefined || !options.flags.has("--yes")) return usage(json);
  const proposal = await readProposal(proposalFile, json);
  if (proposal.error !== null) return proposal.error;
  const context = await mutationContext("create", options, environment, json, {
    affected_supported_game: proposal.value.game,
    target: proposal.value.target,
    content_digest: digest,
    idempotency_key: idempotencyKey,
  });
  if (typeof context === "number") return context;
  return request(environment, json, "/admin/v1/curated-revisions", "POST", {
    environment: "production",
    expected_current_revision_id: expected,
    proposal: proposal.value,
    proposal_digest: digest,
    idempotency_key: idempotencyKey,
  }, context.administrationKey);
}

async function lifecycle(operation, arguments_, environment, json) {
  const valueOptions = [
    "--revision-id", "--event-version", "--conflict-digest", "--rationale",
    "--expected-current-revision", "--idempotency-key", "--environment",
    "--confirm", "--secrets-stdin-fd",
    ...(operation === "supersede" ? ["--proposal", "--proposal-digest"] : []),
  ];
  const options = parseOptions(arguments_, valueOptions, ["--yes"]);
  const revisionId = options.values["--revision-id"];
  const expected = options.values["--expected-current-revision"];
  const idempotencyKey = options.values["--idempotency-key"];
  const rationale = options.values["--rationale"];
  const eventVersion = Number.parseInt(options.values["--event-version"] ?? "", 10);
  const conflictDigest = options.values["--conflict-digest"] ?? null;
  if (options.error !== null || revisionId === undefined || expected === undefined ||
      idempotencyKey === undefined || rationale === undefined ||
      !Number.isSafeInteger(eventVersion) || eventVersion < 1 ||
      (operation === "reaffirm" && options.values["--conflict-digest"] === undefined) ||
      !options.flags.has("--yes")) return usage(json);
  let proposal;
  if (operation === "supersede") {
    if (options.values["--proposal"] === undefined || options.values["--proposal-digest"] === undefined) return usage(json);
    proposal = await readProposal(options.values["--proposal"], json);
    if (proposal.error !== null) return proposal.error;
  }
  const context = await mutationContext(operation, options, environment, json, {
    curated_revision_id: revisionId,
    expected_event_version: eventVersion,
    conflict_digest: conflictDigest,
    idempotency_key: idempotencyKey,
    ...(operation === "supersede"
      ? {
          replacement_supported_game: proposal.value.game,
          replacement_target: proposal.value.target,
          replacement_content_digest: options.values["--proposal-digest"],
        }
      : {}),
  });
  if (typeof context === "number") return context;
  return request(
    environment,
    json,
    `/admin/v1/curated-revisions/${encodeURIComponent(revisionId)}/${operation}`,
    "POST",
    {
      environment: "production",
      expected_current_revision_id: expected,
      expected_event_version: eventVersion,
      conflict_digest: conflictDigest,
      rationale,
      idempotency_key: idempotencyKey,
      ...(operation === "supersede"
        ? { proposal: proposal.value, proposal_digest: options.values["--proposal-digest"] }
        : {}),
    },
    context.administrationKey,
  );
}

async function mutationContext(operation, options, environment, json, binding) {
  if (options.values["--environment"] !== "production") {
    return writeCliFailure(json, {
      code: "production_target_required",
      detail: "Curated Revision mutation requires --environment production.",
    }, 2);
  }
  const secret = readAdministrationSecret(options.values["--secrets-stdin-fd"]);
  if (secret.error !== null) {
    return writeCliFailure(json, { code: "secret_input_error", detail: secret.error }, 2);
  }
  const status = await rawRequest(environment, "/v1/status", "GET", undefined, secret.value);
  if (!status.ok) return requestFailure(json, status);
  if (status.document?.safe_state?.current_revision_id !== options.values["--expected-current-revision"]) {
    return writeCliFailure(json, {
      code: "resolved_target_mismatch",
      detail: "Production does not resolve to the expected Catalogue Revision.",
    }, 7);
  }
  const target = validatedProductionTarget(status.document?.production_target);
  if (target === null) {
    return writeCliFailure(json, {
      code: "invalid_administration_contract",
      detail: "Production status did not expose exact Cloudflare target identities.",
    }, 8);
  }
  let resolvedBinding = binding;
  if (binding.curated_revision_id !== undefined) {
    const shown = await rawRequest(
      environment,
      `/admin/v1/curated-revisions/${encodeURIComponent(binding.curated_revision_id)}`,
      "GET",
      undefined,
      secret.value,
    );
    if (!shown.ok) return requestFailure(json, shown);
    const revision = shown.document?.revision;
    if (revision?.id !== binding.curated_revision_id ||
        typeof revision?.content?.game !== "string" ||
        typeof revision?.content_digest !== "string" ||
        !Number.isSafeInteger(revision?.event_version)) {
      return writeCliFailure(json, {
        code: "invalid_administration_contract",
        detail: "The Curated Revision inspection document is invalid.",
      }, 8);
    }
    if (revision.event_version !== binding.expected_event_version) {
      return writeCliFailure(json, {
        code: "resolved_target_mismatch",
        detail: "The Curated Revision does not resolve to the supplied lifecycle event version.",
      }, 7);
    }
    const resolvedConflict = revision.pending_conflict?.digest ?? null;
    if (binding.conflict_digest !== resolvedConflict) {
      return writeCliFailure(json, {
        code: "resolved_target_mismatch",
        detail: "The Curated Revision does not resolve to the supplied conflict digest.",
      }, 7);
    }
    resolvedBinding = {
      ...binding,
      affected_supported_game: revision.content.game,
      current_content_digest: revision.content_digest,
      target: revision.content.target,
      conflict_id: revision.pending_conflict?.id ?? null,
    };
  }
  const summary = {
    production_target: target,
    operation,
    current_catalogue_revision_id: options.values["--expected-current-revision"],
    ...resolvedBinding,
  };
  const required = JSON.stringify(summary);
  if (options.values["--confirm"] !== required) {
    return writeCliFailure(json, {
      code: "confirmation_required",
      detail: `Resolved Curated Revision mutation ${required}. Re-run with --confirm '${required}'.`,
    }, 3);
  }
  return { administrationKey: secret.value };
}

function readAdministrationSecret(descriptor) {
  if (!/^(0|[3-9]|[1-9][0-9]+)$/.test(descriptor ?? "")) {
    return { error: "The administration key must be supplied through a readable stdin descriptor.", value: "" };
  }
  let text;
  try { text = readFileSync(Number.parseInt(descriptor, 10), "utf8"); }
  catch { return { error: "The administration key stdin descriptor could not be read.", value: "" }; }
  if (Buffer.byteLength(text) > 32_768) return { error: "The secret input exceeds 32 KiB.", value: "" };
  let document;
  try { document = JSON.parse(text); } catch { document = null; }
  if (document === null || typeof document !== "object" || Array.isArray(document) ||
      Object.keys(document).length !== 1 || typeof document.administration_key !== "string" ||
      document.administration_key.length === 0) {
    return { error: "The secret input must contain only a non-empty administration_key.", value: "" };
  }
  return { error: null, value: document.administration_key };
}

function requiredAdministrationSecret(options, json) {
  const secret = readAdministrationSecret(options.values["--secrets-stdin-fd"]);
  return secret.error === null
    ? secret.value
    : writeCliFailure(json, { code: "secret_input_error", detail: secret.error }, 2);
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

async function request(environment, json, pathname, method, body, administrationKey) {
  if (!administrationKey) {
    return writeCliFailure(json, { code: "configuration_error", detail: "Missing required environment: KEEPR_ADMINISTRATION_KEY" }, 2);
  }
  let response;
  try {
    response = await fetch(runtimeUrl(environment.KEEPR_INGESTION_URL ?? "http://127.0.0.1:8788", pathname), {
      method,
      headers: {
        authorization: `Bearer ${administrationKey}`,
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

async function rawRequest(environment, pathname, method, body, administrationKey) {
  let response;
  try {
    response = await fetch(runtimeUrl(environment.KEEPR_INGESTION_URL ?? "http://127.0.0.1:8788", pathname), {
      method,
      headers: {
        authorization: `Bearer ${administrationKey}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false, status: 503, document: { code: "runtime_unavailable", detail: "ingestion runtime is unavailable" } };
  }
  let document;
  try { document = await response.json(); }
  catch { return { ok: false, status: 502, document: { code: "invalid_administration_contract", detail: "ingestion runtime returned invalid JSON" } }; }
  return { ok: response.ok, status: response.status, document };
}

function requestFailure(json, result) {
  return writeCliFailure(json, {
    code: typeof result.document?.code === "string" ? result.document.code : "administration_error",
    detail: typeof result.document?.detail === "string" ? result.document.detail : `ingestion runtime returned HTTP ${result.status}`,
  }, exitCodeForStatus(result.status));
}

function format(document) {
  if (Array.isArray(document.items) && Object.hasOwn(document, "next_cursor")) {
    const revisions = Array.isArray(document.items) ? document.items : [];
    return revisions.length === 0 ? "No Curated Revisions" : revisions.map((revision) => `${revision.id} ${revision.content?.game ?? "unknown"} ${revision.status} ${revision.content_digest}`).join("\n");
  }
  if (document.contract === "card-keepr-curated-revision-validation@1") return `Valid Curated Revision proposal ${document.proposal_digest}`;
  return `Curated Revision ${document.curated_revision_id ?? document.revision?.id}: ${document.status ?? document.revision?.status} (${document.content_digest ?? document.revision?.content_digest ?? "digest unavailable"})`;
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
    detail: "Usage: keepr curated-revision validate|list|show|create|reaffirm|supersede|retire [options] [--json]",
  }, 2);
}
