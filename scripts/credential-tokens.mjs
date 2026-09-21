#!/usr/bin/env node
// Cloudflare API token lifecycle for issue #387: inventory, rename, re-issue
// and revoke the user-owned tokens listed in docs/runbooks/credentials.md,
// driven by one bootstrap token (User > API Tokens > Edit, the "Create
// additional tokens" template) that enters only through KEEPR_TOKEN_ADMIN.
// Every command is a dry run unless --apply is given. Token values are
// created here, handed straight to `wrangler secret put` and the probe, and
// never printed, returned or written to disk.
//
// Usage:
//   node scripts/credential-tokens.mjs inventory
//   node scripts/credential-tokens.mjs rename <token-id> "<target name>" [--apply]
//   node scripts/credential-tokens.mjs reissue production|staging|dev d1-export|d1-verification [--apply]
//   node scripts/credential-tokens.mjs revoke <token-id> [--apply] [--force]
//
// `reissue` installs the new value with `wrangler secret put` on the
// environment's ingestion Worker (wrangler authenticates from
// CLOUDFLARE_API_TOKEN or its own login), runs scripts/credential-probe.mjs
// with the new value and, if the probe fails, deletes the new token again.
// The previous token is reported for an explicit `revoke` once a release has
// proven the new value. For staging and dev the probe identities come from
// <ENV>_CLOUDFLARE_ACCOUNT_ID / <ENV>_CATALOGUE_DATABASE_ID /
// <ENV>_DISPOSABLE_DATABASE_ID, as for the probe.
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { request as httpRequest } from "../cli/lib/http-client.mjs";
import { environmentNames } from "../src/http/environment-target.mjs";
import { probeCredentials, renderProbeTable, resolveProbeTarget } from "./credential-probe.mjs";

const api = "https://api.cloudflare.com/client/v4";
const environments = ["production", "staging", "dev"];
const purposes = ["deploy", "d1-export", "d1-verification"];
const secretNames = { "d1-export": "D1_EXPORT_TOKEN", "d1-verification": "D1_VERIFICATION_TOKEN" };
const probeSlots = { "d1-export": "d1Export", "d1-verification": "d1Verification" };
/** Cloudflare's API names for the runbook's dashboard labels; the first match wins. */
const groupNames = {
  d1Edit: ["D1 Write", "D1 Edit"],
  workersScriptsRead: ["Workers Scripts Read"],
};

export function targetTokenNames() {
  return environments.flatMap((environment) => purposes.map((purpose) => `card-keepr ${environment} ${purpose}`));
}

/** Map a dashboard label to the target it normalises to, or null. */
export function suggestTargetName(name) {
  const words = name.toLowerCase().replace(/[-_]+/gu, " ").split(/\s+/u).filter(Boolean);
  const [prefix, keepr, environment, ...rest] = words;
  if (`${prefix} ${keepr}` !== "card keepr" || !environments.includes(environment)) return null;
  const purpose = rest.join("-");
  return purposes.includes(purpose) ? `card-keepr ${environment} ${purpose}` : null;
}

/** Classify each dashboard token against the runbook table; policies only, never values. */
export function classifyTokens(tokens) {
  const targets = new Set(targetTokenNames());
  const seen = new Set();
  return tokens.map((token) => {
    const targetName = suggestTargetName(token.name);
    let classification = "no-consumer";
    if (targetName !== null && targets.has(targetName)) {
      if (seen.has(targetName)) classification = "duplicate";
      else if (token.name === targetName) classification = "target";
      else classification = "rename";
      if (token.name === targetName && classification !== "duplicate") seen.add(targetName);
    }
    return {
      id: token.id,
      name: token.name,
      status: token.status,
      issuedOn: token.issued_on ?? null,
      lastUsedOn: token.last_used_on ?? null,
      grants: describeGrants(token.policies ?? []),
      classification,
      targetName,
    };
  });
}

function describeGrants(policies) {
  return policies.flatMap((policy) => {
    const scope = Object.keys(policy.resources ?? {})
      .map((key) =>
        key.startsWith("com.cloudflare.api.account.zone.")
          ? "zone"
          : key.startsWith("com.cloudflare.api.account.")
            ? "account"
            : key,
      )
      .join("+");
    const effect = policy.effect === "deny" ? "deny " : "";
    return (policy.permission_groups ?? []).map((group) => `${effect}${group.name ?? group.id} @ ${scope}`);
  });
}

export function renderInventory(rows) {
  const columns = ["id", "classification", "status", "lastUsedOn", "name", "targetName"];
  const cell = (row, key) => String(row[key] ?? "-");
  const widths = Object.fromEntries(
    columns.map((key) => [key, Math.max(key.length, ...rows.map((row) => cell(row, key).length))]),
  );
  const lines = [columns.map((key) => key.toUpperCase().padEnd(widths[key])).join("  ")];
  for (const row of rows) {
    lines.push(columns.map((key) => cell(row, key).padEnd(widths[key])).join("  "));
    for (const grant of row.grants) lines.push(`${"".padEnd(widths.id + 2)}${grant}`);
  }
  const counts = {};
  for (const row of rows) counts[row.classification] = (counts[row.classification] ?? 0) + 1;
  lines.push(
    `tokens: ${rows.length}; ${Object.entries(counts)
      .map(([key, count]) => `${key} ${count}`)
      .join(", ")}`,
  );
  return `${lines.join("\n")}\n`;
}

/** The runbook grant for one re-issued token, as Cloudflare policies. */
export function reissuePolicies({ environment, purpose, accountId }, permissionGroups) {
  if (!environments.includes(environment)) throw new Error("environment must be one of production, staging, dev");
  if (!(purpose in secretNames)) throw new Error("purpose must be d1-export or d1-verification");
  const wanted = [groupNames.d1Edit];
  if (purpose === "d1-verification" && environment === "production") wanted.push(groupNames.workersScriptsRead);
  const ids = wanted.map((names) => {
    const group = permissionGroups.find((candidate) => names.includes(candidate.name));
    if (!group) throw new Error(`permission group ${names[0]} is not available to this token`);
    return { id: group.id };
  });
  return [{ effect: "allow", resources: { [`com.cloudflare.api.account.${accountId}`]: "*" }, permission_groups: ids }];
}

async function call(admin, method, path, body, fetchImpl) {
  const response = await httpRequest(
    `${api}${path}`,
    {
      method,
      headers: {
        authorization: `Bearer ${admin}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    },
    fetchImpl,
  );
  const document = await response.json().catch(() => null);
  if (document === null || document.success !== true) {
    const codes = Array.isArray(document?.errors) ? document.errors.map((error) => error?.code).join(",") : "?";
    throw new Error(
      `${method} ${path.replace(/^\/user\/tokens\/[0-9a-f]+/u, "/user/tokens/…")} failed: HTTP ${response.status} errors ${codes}`,
    );
  }
  return document.result;
}

export async function listTokens(admin, fetchImpl = fetch) {
  return call(admin, "GET", "/user/tokens?per_page=50", undefined, fetchImpl);
}

async function findToken(admin, id, fetchImpl) {
  const tokens = await listTokens(admin, fetchImpl);
  const token = tokens.find((candidate) => candidate.id === id);
  if (!token) throw new Error(`token ${id} not found`);
  return token;
}

export async function renameToken({ admin, id, name, apply = false }, fetchImpl = fetch) {
  if (!targetTokenNames().includes(name)) throw new Error(`${name} is not a target name from the runbook`);
  const token = await findToken(admin, id, fetchImpl);
  const result = { id, from: token.name, to: name, applied: false };
  if (!apply) return result;
  await call(admin, "PUT", `/user/tokens/${id}`, { ...token, name }, fetchImpl);
  return { ...result, applied: true };
}

export async function revokeToken({ admin, id, apply = false, force = false }, fetchImpl = fetch) {
  const token = await findToken(admin, id, fetchImpl);
  if (targetTokenNames().includes(token.name) && !force)
    throw new Error(`${token.name} is a target-named token; pass --force to revoke it`);
  const result = { id, name: token.name, applied: false };
  if (!apply) return result;
  await call(admin, "DELETE", `/user/tokens/${id}`, undefined, fetchImpl);
  return { ...result, applied: true };
}

/**
 * Create the replacement token, install it, probe it and report the tokens it
 * replaces. `install` and `probe` are injectable so tests never spawn
 * wrangler or reach Cloudflare; both receive the value and never return it.
 */
export async function reissueToken(
  { admin, target, purpose, apply = false, install = installWorkerSecret, probe },
  fetchImpl = fetch,
) {
  const environment = target.environment;
  const name = `card-keepr ${environment} ${purpose}`;
  const [, worker] = environmentNames(environment).workers;
  const [tokens, permissionGroups] = await Promise.all([
    listTokens(admin, fetchImpl),
    call(admin, "GET", "/user/tokens/permission_groups", undefined, fetchImpl),
  ]);
  const policies = reissuePolicies({ environment, purpose, accountId: target.accountId }, permissionGroups);
  const previous = tokens.filter((token) => suggestTargetName(token.name) === name).map((token) => token.id);
  const plan = { name, secretName: secretNames[purpose], worker, policies, previous, applied: false };
  if (!apply) return plan;

  const created = await call(admin, "POST", "/user/tokens", { name, policies }, fetchImpl);
  const value = created.value;
  const runProbe = probe ?? ((values) => probeCredentials({ target, tokens: values }, fetchImpl));
  const probeResult = await runProbe({ [probeSlots[purpose]]: value });
  if (!probeResult.ok) {
    await call(admin, "DELETE", `/user/tokens/${created.id}`, undefined, fetchImpl);
    return { ...plan, applied: true, created: null, probe: probeResult };
  }
  await install({ secretName: secretNames[purpose], worker, accountId: target.accountId, value });
  return { ...plan, applied: true, created: created.id, probe: probeResult };
}

/** `wrangler secret put <NAME> --name <worker>` with the value on stdin. */
async function installWorkerSecret({ secretName, worker, accountId, value }) {
  const execute = promisify(execFile);
  await execute(resolve("node_modules/.bin/wrangler"), ["secret", "put", secretName, "--name", worker], {
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
    input: value,
    maxBuffer: 1 << 20,
  }).catch((error) => {
    throw new Error(`wrangler secret put ${secretName} --name ${worker} failed (exit ${error.code ?? "?"})`);
  });
}

function usage() {
  process.stderr.write(
    [
      "usage: node scripts/credential-tokens.mjs inventory",
      '       node scripts/credential-tokens.mjs rename <token-id> "<target name>" [--apply]',
      "       node scripts/credential-tokens.mjs reissue production|staging|dev d1-export|d1-verification [--apply]",
      "       node scripts/credential-tokens.mjs revoke <token-id> [--apply] [--force]",
      "KEEPR_TOKEN_ADMIN holds the bootstrap token (User > API Tokens > Edit).",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((arg) => arg.startsWith("--")));
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const [command, ...rest] = positional;
  const apply = flags.has("--apply");
  const force = flags.has("--force");
  for (const flag of flags) if (!["--apply", "--force"].includes(flag)) usage();
  const admin = process.env.KEEPR_TOKEN_ADMIN;
  if (!command || typeof admin !== "string" || admin.length === 0) usage();
  const mode = apply ? "applied" : "dry run (add --apply)";
  if (command === "inventory" && rest.length === 0) {
    process.stdout.write(renderInventory(classifyTokens(await listTokens(admin))));
  } else if (command === "rename" && rest.length === 2) {
    const result = await renameToken({ admin, id: rest[0], name: rest[1], apply });
    process.stdout.write(`rename ${result.id}: "${result.from}" -> "${result.to}" [${mode}]\n`);
  } else if (command === "revoke" && rest.length === 1) {
    const result = await revokeToken({ admin, id: rest[0], apply, force });
    process.stdout.write(`revoke ${result.id} "${result.name}" [${mode}]\n`);
  } else if (command === "reissue" && rest.length === 2) {
    const [environment, purpose] = rest;
    const target = await resolveProbeTarget(environment, process.env);
    const result = await reissueToken({ admin, target, purpose, apply });
    process.stdout.write(`reissue "${result.name}" -> ${result.worker} secret ${result.secretName} [${mode}]\n`);
    process.stdout.write(`  grants: ${JSON.stringify(result.policies[0].permission_groups)}\n`);
    process.stdout.write(`  replaces: ${result.previous.length === 0 ? "nothing" : result.previous.join(", ")}\n`);
    if (result.applied) {
      process.stdout.write(
        renderProbeTable({ environment, accountId: target.accountId, rows: result.probe.rows, ok: result.probe.ok }),
      );
      if (result.created === null) {
        process.stdout.write("probe failed: the new token was deleted and the Worker secret is unchanged\n");
        process.exit(1);
      }
      process.stdout.write(
        `created ${result.created} and installed; revoke ${result.previous.join(", ") || "nothing"} once a release proves it\n`,
      );
    }
  } else usage();
}
