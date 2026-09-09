import { readFile } from "node:fs/promises";
import { parseOptions, targetConfirmationDetail, writeCliFailure } from "./command-support.mjs";
import { requestDocument } from "./lib/json-client.mjs";
import { readAdministrationSecret } from "./lib/secret-input.mjs";

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
  const proposalRead = await readProposal(proposalFile, json);
  if (proposalRead.error !== null) return proposalRead.error;
  const secret = requiredAdministrationSecret(options, json);
  if (typeof secret === "number") return secret;
  return request(
    environment,
    json,
    "/admin/v1/curated-revisions/validate",
    "POST",
    {
      proposal: proposalRead.value,
      catalogue_revision_id: expected,
    },
    secret,
  );
}

async function list(arguments_, environment, json) {
  const options = parseOptions(arguments_, ["--game", "--target", "--status", "--secrets-stdin-fd"]);
  if (options.error !== null) return usage(json);
  const secret = requiredAdministrationSecret(options, json);
  if (typeof secret === "number") return secret;
  const query = new URLSearchParams();
  for (const [option, parameter] of [
    ["--game", "game"],
    ["--target", "target"],
    ["--status", "status"],
  ]) {
    const value = options.values[option];
    if (value !== undefined) query.set(parameter, value);
  }
  return request(
    environment,
    json,
    `/admin/v1/curated-revisions${query.size === 0 ? "" : `?${query}`}`,
    "GET",
    undefined,
    secret,
  );
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
  const options = parseOptions(
    arguments_,
    [
      "--proposal",
      "--proposal-digest",
      "--expected-current-revision",
      "--idempotency-key",
      "--environment",
      "--confirm",
      "--secrets-stdin-fd",
    ],
    ["--yes"],
  );
  const proposalFile = options.values["--proposal"];
  const digest = options.values["--proposal-digest"];
  const expected = options.values["--expected-current-revision"];
  const idempotencyKey = options.values["--idempotency-key"];
  if (
    options.error !== null ||
    proposalFile === undefined ||
    digest === undefined ||
    expected === undefined ||
    idempotencyKey === undefined ||
    !options.flags.has("--yes")
  )
    return usage(json);
  const proposalRead = await readProposal(proposalFile, json);
  if (proposalRead.error !== null) return proposalRead.error;
  const context = await mutationContext("create", options, environment, json, {
    affected_supported_game: proposalRead.value.game,
    target: proposalRead.value.target,
    content_digest: digest,
    idempotency_key: idempotencyKey,
  });
  if (typeof context === "number") return context;
  return request(
    environment,
    json,
    "/admin/v1/curated-revisions",
    "POST",
    {
      environment: environment.KEEPR_TARGET ?? "production",
      expected_current_revision_id: expected,
      proposal: proposalRead.value,
      proposal_digest: digest,
      idempotency_key: idempotencyKey,
    },
    context.administrationKey,
  );
}

async function lifecycle(operation, arguments_, environment, json) {
  const valueOptions = [
    "--revision-id",
    "--event-version",
    "--conflict-digest",
    "--rationale",
    "--expected-current-revision",
    "--idempotency-key",
    "--environment",
    "--confirm",
    "--secrets-stdin-fd",
    ...(operation === "supersede" ? ["--proposal", "--proposal-digest"] : []),
  ];
  const options = parseOptions(arguments_, valueOptions, ["--yes"]);
  const revisionId = options.values["--revision-id"];
  const expected = options.values["--expected-current-revision"];
  const idempotencyKey = options.values["--idempotency-key"];
  const rationale = options.values["--rationale"];
  const eventVersion = Number.parseInt(options.values["--event-version"] ?? "", 10);
  const conflictDigest = options.values["--conflict-digest"] ?? null;
  if (
    options.error !== null ||
    revisionId === undefined ||
    expected === undefined ||
    idempotencyKey === undefined ||
    rationale === undefined ||
    !Number.isSafeInteger(eventVersion) ||
    eventVersion < 1 ||
    (operation === "reaffirm" && options.values["--conflict-digest"] === undefined) ||
    !options.flags.has("--yes")
  )
    return usage(json);
  let proposalRead;
  if (operation === "supersede") {
    if (options.values["--proposal"] === undefined || options.values["--proposal-digest"] === undefined)
      return usage(json);
    proposalRead = await readProposal(options.values["--proposal"], json);
    if (proposalRead.error !== null) return proposalRead.error;
  }
  const context = await mutationContext(operation, options, environment, json, {
    curated_revision_id: revisionId,
    expected_event_version: eventVersion,
    conflict_digest: conflictDigest,
    idempotency_key: idempotencyKey,
    ...(operation === "supersede"
      ? {
          replacement_supported_game: proposalRead.value.game,
          replacement_target: proposalRead.value.target,
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
      environment: environment.KEEPR_TARGET ?? "production",
      expected_current_revision_id: expected,
      expected_event_version: eventVersion,
      conflict_digest: conflictDigest,
      rationale,
      idempotency_key: idempotencyKey,
      ...(operation === "supersede"
        ? { proposal: proposalRead.value, proposal_digest: options.values["--proposal-digest"] }
        : {}),
    },
    context.administrationKey,
  );
}

async function mutationContext(operation, options, environment, json, binding) {
  if (options.values["--environment"] !== (environment.KEEPR_TARGET ?? "production")) {
    return writeCliFailure(
      json,
      {
        code: "production_target_required",
        detail: targetConfirmationDetail("Curated Revision mutation", environment),
      },
      2,
    );
  }
  const secret = readAdministrationSecret(options.values["--secrets-stdin-fd"]);
  if (secret.error !== null) {
    return writeCliFailure(json, { code: "secret_input_error", detail: secret.error }, 2);
  }
  const query = new URLSearchParams({
    expected_current_revision_id: options.values["--expected-current-revision"],
    curated_operation: operation,
    curated_binding: JSON.stringify(binding),
  });
  const status = await rawRequest(environment, `/v1/status?${query}`, "GET", undefined, secret.value);
  if (status.error !== null) return requestFailure(json, status);
  const required = status.document?.resolved_target?.confirmation;
  if (typeof required !== "string")
    return writeCliFailure(
      json,
      {
        code: "invalid_administration_contract",
        detail: "Production status did not expose exact Cloudflare target identities.",
      },
      8,
    );
  if (options.values["--confirm"] !== required)
    return writeCliFailure(
      json,
      {
        code: "confirmation_required",
        detail: `Resolved Curated Revision mutation ${required}. Re-run with --confirm '${required}'.`,
      },
      3,
    );
  return { administrationKey: secret.value };
}

function requiredAdministrationSecret(options, json) {
  const secret = readAdministrationSecret(options.values["--secrets-stdin-fd"]);
  return secret.error === null
    ? secret.value
    : writeCliFailure(json, { code: "secret_input_error", detail: secret.error }, 2);
}

// Reads the Curated Revision Proposal (the `proposal` request field and
// `--proposal` option are its short form) from a file or stdin. Returns a
// read result, not the proposal itself: `{ error: null, value }` on success
// or `{ error: exitCode, value: null }` after writing the CLI failure.
async function readProposal(path, json) {
  try {
    const text = path === "-" ? await stdinText() : await readFile(path, "utf8");
    const value = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return { error: null, value };
  } catch {
    return {
      error: writeCliFailure(
        json,
        {
          code: "invalid_proposal_file",
          detail: "The proposal file or stdin must contain one JSON object.",
        },
        8,
      ),
      value: null,
    };
  }
}

async function request(environment, json, pathname, method, body, administrationKey) {
  const result = await rawRequest(environment, pathname, method, body, administrationKey);
  if (result.error !== null) return requestFailure(json, result);
  process.stdout.write(json ? `${JSON.stringify(result.document)}\n` : `${format(result.document)}\n`);
  return 0;
}
function rawRequest(environment, pathname, method, body, key) {
  return requestDocument(environment, pathname, { method, body, key });
}
function requestFailure(json, result) {
  return writeCliFailure(json, result.error, result.exitCode);
}

function format(document) {
  if (Array.isArray(document.items) && Object.hasOwn(document, "next_cursor")) {
    const revisions = Array.isArray(document.items) ? document.items : [];
    return revisions.length === 0
      ? "No Curated Revisions"
      : revisions
          .map(
            (revision) =>
              `${revision.id} ${revision.content?.game ?? "unknown"} ${revision.status} ${revision.content_digest}`,
          )
          .join("\n");
  }
  if (document.contract === "card-keepr-curated-revision-validation@1")
    return `Valid Curated Revision proposal ${document.proposal_digest}`;
  return `Curated Revision ${document.curated_revision_id ?? document.revision?.id}: ${document.status ?? document.revision?.status} (${document.content_digest ?? document.revision?.content_digest ?? "digest unavailable"})`;
}

function stdinText() {
  return new Promise((resolve, reject) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      text += chunk;
    });
    process.stdin.once("end", () => resolve(text));
    process.stdin.once("error", reject);
  });
}

function usage(json) {
  return writeCliFailure(
    json,
    {
      code: "usage_error",
      detail: "Usage: keepr curated-revision validate|list|show|create|reaffirm|supersede|retire [options] [--json]",
    },
    2,
  );
}
