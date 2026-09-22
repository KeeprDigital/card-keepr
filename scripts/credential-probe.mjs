#!/usr/bin/env node
// Read-only credential probe (issue #387). Each Cloudflare token the system
// holds is exercised against the exact provider calls the code makes with it,
// so a token whose grants drift from the code's needs fails here instead of
// inside a release. Token values enter only through environment variables and
// are never printed; every row reports the HTTP status alone.
//
// Usage: node scripts/credential-probe.mjs production|staging|dev [--exercise-export]
//   KEEPR_PROBE_DEPLOYMENT_TOKEN       the GitHub *_DEPLOYMENT_TOKEN value
//   KEEPR_PROBE_D1_EXPORT_TOKEN        the ingestion Worker's D1_EXPORT_TOKEN
//   KEEPR_PROBE_D1_VERIFICATION_TOKEN  the ingestion Worker's D1_VERIFICATION_TOKEN
// Non-secret identities come from apps/ingestion/wrangler.jsonc (production)
// or <ENV>_CLOUDFLARE_ACCOUNT_ID / <ENV>_CATALOGUE_DATABASE_ID /
// <ENV>_DISPOSABLE_DATABASE_ID (dev, staging), the same names the GitHub
// environments and provisioning scripts use.
import { pathToFileURL } from "node:url";
import { readWorkerConfig } from "../cli/lib/config.mjs";
import { request as httpRequest } from "../cli/lib/http-client.mjs";
import { environmentNames } from "../src/http/environment-target.mjs";

const api = "https://api.cloudflare.com/client/v4";
const zoneName = "keepr.digital";
const tokenLabels = {
  deployment: "deployment",
  d1Export: "D1_EXPORT_TOKEN",
  d1Verification: "D1_VERIFICATION_TOKEN",
};
const disposableImplication =
  "the ingestion Worker cannot resolve the live Disposable Restore database: backups, recovery and dev/staging deployments answer 500 (src/catalogue/backup-recovery/backup-recovery.ts:1163)";

/** Resolve the non-secret target identities for one environment. */
export async function resolveProbeTarget(environment, env) {
  if (!["production", "staging", "dev"].includes(environment))
    throw new Error("environment must be one of production, staging, dev");
  if (environment === "production") {
    const config = await readWorkerConfig("apps/ingestion/wrangler.jsonc");
    const vars = /** @type {Record<string, string>} */ (config.vars);
    const [database] = /** @type {{database_id: string}[]} */ (config.d1_databases);
    return {
      environment,
      accountId: vars.CLOUDFLARE_ACCOUNT_ID,
      catalogueDatabaseId: database.database_id,
      disposableDatabaseId: vars.DISPOSABLE_D1_DATABASE_ID,
    };
  }
  const prefix = environment.toUpperCase();
  const value = (name) => {
    const found = env[`${prefix}_${name}`];
    if (typeof found !== "string" || found.length === 0) throw new Error(`${prefix}_${name} is required`);
    return found;
  };
  return {
    environment,
    accountId: value("CLOUDFLARE_ACCOUNT_ID"),
    catalogueDatabaseId: value("CATALOGUE_DATABASE_ID"),
    disposableDatabaseId: value("DISPOSABLE_DATABASE_ID"),
  };
}

/**
 * The checks each token must pass, derived from the code path that uses it.
 * `kind` selects how the request is built; `after` names a check whose result
 * this one consumes (a version id, a zone id, the live disposable id).
 */
export function probePlan(target, { exerciseExport = false } = {}) {
  const names = environmentNames(target.environment);
  const account = `/accounts/${target.accountId}`;
  const isolated = target.environment !== "production";
  const plan = [];
  const add = (slot, check, source, entry) => plan.push({ slot, token: tokenLabels[slot], check, source, ...entry });

  // Deployment token: the release executor and provider scripts.
  add("deployment", "token-verify", "scripts/production-release-provider.mjs:43", verifyEntry());
  for (const database of [target.catalogueDatabaseId]) {
    add("deployment", "d1-database-read", "scripts/production-release-provider.mjs:252", {
      path: `${account}/d1/database/${database}`,
    });
  }
  add("deployment", "d1-list-by-name", "scripts/provision-dev.mjs:42", {
    path: `${account}/d1/database?name=${encodeURIComponent(names.disposable)}`,
    resolves: "disposable",
  });
  for (const worker of names.workers) {
    add("deployment", "workers-settings-read", "scripts/production-release-provider.mjs:317", {
      path: `${account}/workers/scripts/${worker}/settings`,
    });
    add("deployment", "workers-deployments-read", "scripts/production-release-provider.mjs:131", {
      path: `${account}/workers/scripts/${worker}/deployments`,
      resolves: `version:${worker}`,
    });
    add("deployment", "workers-version-read", "scripts/production-release-provider.mjs:154", {
      path: `${account}/workers/scripts/${worker}/versions/{version}`,
      after: `version:${worker}`,
    });
  }
  for (const bucket of names.buckets) {
    const root = `${account}/r2/buckets/${bucket}`;
    add("deployment", "r2-bucket-read", "scripts/production-release-provider.mjs:267", { path: root });
    add("deployment", "r2-bucket-managed-domain-read", "scripts/production-release-provider.mjs:270", {
      path: `${root}/domains/managed`,
    });
    add("deployment", "r2-bucket-custom-domain-read", "scripts/production-release-provider.mjs:271", {
      path: `${root}/domains/custom`,
    });
  }
  add("deployment", "zone-read", "scripts/production-release-provider.mjs:184", {
    path: `/zones?name=${zoneName}&account.id=${target.accountId}`,
    resolves: "zone",
  });
  add("deployment", "zone-routes-read", "scripts/production-release-provider.mjs:184", {
    path: "/zones/{zone}/workers/routes",
    after: "zone",
  });
  if (isolated) {
    for (const workflow of names.workflows) {
      add("deployment", "workflows-read", "scripts/dev-workflows.mjs:19", {
        path: `${account}/workflows/${workflow}`,
        accept: [200, 404],
      });
    }
  }
  add("deployment", "workers-version-upload", ".github/workflows/production-release.yml:248", {
    notProbed: "write: wrangler versions upload/deploy, triggers deploy and d1 migrations apply are not exercised",
  });

  // Export token: only the SQL export of the catalogue database.
  add("d1Export", "token-verify", "src/catalogue/backup-recovery/backup-recovery.ts:1046", verifyEntry());
  add("d1Export", "d1-database-read", "src/catalogue/backup-recovery/backup-recovery.ts:1046", {
    path: `${account}/d1/database/${target.catalogueDatabaseId}`,
  });
  add("d1Export", "d1-export-exercise", "src/catalogue/backup-recovery/backup-recovery.ts:1050", exportEntry());

  // Verification token: Disposable Restore lifecycle and recovery.
  add("d1Verification", "token-verify", "src/catalogue/backup-recovery/backup-recovery.ts:1163", verifyEntry());
  add("d1Verification", "d1-list-by-name", "src/catalogue/backup-recovery/backup-recovery.ts:1163", {
    path: `${account}/d1/database?name=${encodeURIComponent(names.disposable)}`,
    resolves: "disposable",
    implication: disposableImplication,
  });
  add("d1Verification", "d1-time-travel-bookmark-read", "src/catalogue/backup-recovery/recovery.ts:1250", {
    path: `${account}/d1/database/${target.catalogueDatabaseId}/time_travel/bookmark`,
  });
  add("d1Verification", "d1-export-exercise", "src/catalogue/backup-recovery/backup-recovery.ts:1096", exportEntry());
  add("d1Verification", "d1-restore-write", "src/catalogue/backup-recovery/backup-recovery.ts:1082", {
    notProbed: "write: disposable create/delete, import, query and time-travel restore are not exercised",
  });
  return plan;

  // User-owned tokens verify at /user/tokens/verify; account-owned ones only at the account endpoint.
  function verifyEntry() {
    return { path: "/user/tokens/verify", fallback: `${account}/tokens/verify` };
  }

  function exportEntry() {
    return exerciseExport
      ? {
          method: "POST",
          path: `${account}/d1/database/{disposable}/export`,
          after: "disposable",
          body: { output_format: "polling" },
        }
      : { notProbed: "opt-in: --exercise-export starts one SQL export of the Disposable Restore database only" };
  }
}

/**
 * @param {{target: object, tokens: Record<string, string | undefined>, exerciseExport?: boolean}} input
 * @param {typeof globalThis.fetch} [fetchImpl]
 */
export async function probeCredentials({ target, tokens, exerciseExport = false }, fetchImpl = fetch) {
  const plan = probePlan(target, { exerciseExport });
  const resolved = new Map();
  const rows = [];
  for (const check of plan) {
    const token = tokens[check.slot];
    const base = { token: check.token, check: check.check, source: check.source, method: check.method ?? "GET" };
    if (check.notProbed) {
      rows.push({ ...base, path: "-", status: null, outcome: "not_probed", detail: check.notProbed });
      continue;
    }
    if (typeof token !== "string" || token.length === 0) {
      rows.push({ ...base, path: check.path, status: null, outcome: "skipped", detail: "token not supplied" });
      continue;
    }
    let path = check.path;
    if (check.after) {
      const dependency = resolved.get(`${check.slot}:${check.after}`) ?? resolved.get(`deployment:${check.after}`);
      if (dependency === undefined) {
        rows.push({ ...base, path, status: null, outcome: "skipped", detail: `needs ${check.after}` });
        continue;
      }
      path = path.replace(/\{[a-z]+\}/u, encodeURIComponent(dependency));
    }
    let observed = await observe(fetchImpl, token, base.method, path, check.body);
    if (check.fallback && observed.document?.success !== true) {
      const fallback = await observe(fetchImpl, token, base.method, check.fallback, check.body);
      if (fallback.document?.success === true) {
        observed = fallback;
        path = check.fallback;
      }
    }
    const accepted = (check.accept ?? [200]).includes(observed.status);
    const pass =
      accepted && observed.document !== null && (observed.status === 404 || observed.document.success === true);
    if (pass && check.resolves) {
      const value = resolveValue(check.resolves, observed.document);
      if (value !== null) resolved.set(`${check.slot}:${check.resolves}`, value);
    }
    rows.push({
      ...base,
      path,
      status: observed.status,
      outcome: pass ? "pass" : "fail",
      detail: pass ? "" : observed.detail,
      ...(pass || !check.implication ? {} : { implication: check.implication }),
    });
  }
  return {
    environment: target.environment,
    accountId: target.accountId,
    rows,
    ok: rows.every((row) => row.outcome !== "fail"),
  };
}

function resolveValue(name, document) {
  const result = document.result;
  if (name === "disposable") {
    const ids = Array.isArray(result) ? result.map((entry) => entry?.uuid).filter((id) => typeof id === "string") : [];
    return ids.length === 1 ? ids[0] : null;
  }
  if (name === "zone") {
    return Array.isArray(result) && result.length === 1 && typeof result[0]?.id === "string" ? result[0].id : null;
  }
  const versions = result?.deployments?.[0]?.versions;
  return Array.isArray(versions) && versions.length === 1 && typeof versions[0]?.version_id === "string"
    ? versions[0].version_id
    : null;
}

async function observe(fetchImpl, token, method, path, body) {
  try {
    const response = await httpRequest(
      `${api}${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      },
      fetchImpl,
    );
    let document = null;
    try {
      document = await response.json();
    } catch {
      document = null;
    }
    const detail =
      document === null
        ? "non-JSON response"
        : document.success === true
          ? ""
          : `errors: ${Array.isArray(document.errors) ? document.errors.map((error) => error?.code).join(",") : "?"}`;
    return { status: response.status, document, detail };
  } catch {
    // Transport failures may carry request details; never echo them.
    return { status: null, document: null, detail: "request failed before a response" };
  }
}

export function renderProbeTable(result) {
  const lines = [`credential probe: ${result.environment} (account ${result.accountId})`];
  const width = (key) => Math.max(...result.rows.map((row) => String(cell(row, key)).length), key.length);
  const columns = ["token", "check", "path", "status", "outcome"];
  const widths = Object.fromEntries(columns.map((key) => [key, width(key)]));
  lines.push(columns.map((key) => key.toUpperCase().padEnd(widths[key])).join("  "));
  for (const row of result.rows) {
    lines.push(columns.map((key) => String(cell(row, key)).padEnd(widths[key])).join("  "));
    if (row.detail && row.outcome !== "pass") lines.push(`${"".padEnd(widths.token + 2)}${row.detail}`);
    if (row.implication) lines.push(`${"".padEnd(widths.token + 2)}implication: ${row.implication}`);
  }
  lines.push(result.ok ? "result: pass" : "result: fail (see rows marked fail)");
  return `${lines.join("\n")}\n`;
}

function cell(row, key) {
  if (key === "status") return row.status ?? "-";
  if (key === "path") return row.path.replace(/^\/accounts\/[0-9a-f]{32}/u, "/accounts/…");
  return row[key];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [environment, ...flags] = process.argv.slice(2);
  const exerciseExport = flags.includes("--exercise-export");
  if (!environment || flags.some((flag) => flag !== "--exercise-export")) {
    process.stderr.write("usage: node scripts/credential-probe.mjs production|staging|dev [--exercise-export]\n");
    process.exit(2);
  }
  const tokens = {
    // Staging and dev fall back to the owner env file's deploy token name (.env.example).
    deployment:
      process.env.KEEPR_PROBE_DEPLOYMENT_TOKEN ||
      (environment === "production" ? undefined : process.env[`${environment.toUpperCase()}_DEPLOYMENT_TOKEN`]),
    d1Export: process.env.KEEPR_PROBE_D1_EXPORT_TOKEN,
    d1Verification: process.env.KEEPR_PROBE_D1_VERIFICATION_TOKEN,
  };
  if (Object.values(tokens).every((token) => !token)) {
    process.stderr.write("set at least one KEEPR_PROBE_* token variable\n");
    process.exit(2);
  }
  const target = await resolveProbeTarget(environment, process.env);
  const result = await probeCredentials({ target, tokens, exerciseExport });
  process.stdout.write(renderProbeTable(result));
  process.exit(result.ok ? 0 : 1);
}
