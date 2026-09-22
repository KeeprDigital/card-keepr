/** Pure decisions for `keepr release run`; the command owns I/O. */

import { environmentNames } from "../src/http/environment-target.mjs";

export const releaseKinds = Object.freeze({
  staging: {
    idPrefix: "staging",
    workflow: "staging-deploy.yml",
    title: (id, sha) => `staging-${id}-${sha}`,
    titlePattern: /^staging-(.+)-([0-9a-f]{40})$/u,
  },
  production: {
    idPrefix: "release",
    workflow: "production-release.yml",
    title: (id, sha) => `production-release-${id}-${sha}`,
    titlePattern: /^production-release-(.+)-([0-9a-f]{40})$/u,
  },
});

const confirmationPrefix = "Confirmation must exactly equal ";

/** Latest successful push `ci.yml` run on main for an exact commit, or null. */
export function ciRunFor(sha, ciRuns) {
  const runs = ciRuns
    .filter((run) => run.head_sha === sha && run.event === "push" && run.conclusion === "success")
    .sort((a, b) => b.id - a.id);
  return runs[0]?.id === undefined ? null : String(runs[0].id);
}

export function devDeliveredFor(sha, devRuns) {
  return devRuns.some(
    (run) => run.head_sha === sha && run.conclusion === "success" && String(run.display_title).startsWith("dev-"),
  );
}

/**
 * Newest first-parent main commit whose push CI and dev delivery both succeeded.
 * @param {{ commits: string[], ciRuns: any[], devRuns: any[] }} evidence commits newest first
 */
export function selectReleaseCommit({ commits, ciRuns, devRuns }) {
  for (const sha of commits) {
    const ciRunId = ciRunFor(sha, ciRuns);
    if (ciRunId !== null && devDeliveredFor(sha, devRuns)) return { sha, ciRunId };
  }
  return null;
}

/** `<prefix>-YYYY-MM-DD-NN` with the next NN after every id already used that UTC day. */
export function nextReleaseId(kind, now, usedIds) {
  const day = `${releaseKinds[kind].idPrefix}-${now.toISOString().slice(0, 10)}-`;
  const numbers = usedIds
    .filter((id) => id.startsWith(day) && /^\d{2,}$/u.test(id.slice(day.length)))
    .map((id) => Number(id.slice(day.length)));
  return `${day}${String(Math.max(0, ...numbers) + 1).padStart(2, "0")}`;
}

export function incrementReleaseId(id) {
  const match = /^(.*-)(\d{2,})$/u.exec(id);
  if (match === null) throw new Error(`Release ID ${id} has no numeric suffix`);
  return `${match[1]}${String(Number(match[2]) + 1).padStart(2, "0")}`;
}

/** Release IDs recorded in the workflow's run names (the `run-name` in its YAML). */
export function releaseIdsFromRuns(kind, runs) {
  return runs
    .map((run) => releaseKinds[kind].titlePattern.exec(String(run.display_title ?? run.name ?? ""))?.[1])
    .filter((id) => id !== undefined);
}

/**
 * The run this dispatch created: its exact run name, and not a run that already
 * existed before dispatch (a replayed release ID keeps its earlier runs).
 */
export function matchDispatchedRun(runs, title, earlierIds) {
  const matches = runs.filter(
    (run) =>
      run.event === "workflow_dispatch" && (run.display_title ?? run.name) === title && !earlierIds.has(String(run.id)),
  );
  if (matches.length > 1) throw new Error(`More than one new workflow run is named ${title}`);
  return matches[0] ?? null;
}

/**
 * The exact server confirmation from the low-level command's JSON problem.
 * Returned byte for byte; parsing it is only for display.
 */
export function confirmationFromProblem(problem) {
  if (
    problem?.code !== "confirmation_required" ||
    typeof problem.detail !== "string" ||
    !problem.detail.startsWith(confirmationPrefix)
  )
    return null;
  const confirmation = problem.detail.slice(confirmationPrefix.length);
  return confirmation.length === 0 ? null : confirmation;
}

const list = (values) => (Array.isArray(values) && values.length > 0 ? values.join(", ") : "none");
const databases = (target) => list((target?.d1_databases ?? []).map((database) => `${database.name} (${database.id})`));

/** Human lines for the exact envelope; throws when it does not bind this request. */
export function describeEnvelope(kind, envelope, { releaseId, sha, subject }) {
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope))
    throw new Error("The server confirmation is not a JSON object.");
  if (envelope.release_id !== releaseId || envelope.expected_head_sha !== sha)
    throw new Error("The server confirmation does not name this release ID and commit.");
  const target = kind === "staging" ? envelope.production_start?.target : envelope.production_target;
  const level = kind === "staging" ? envelope.production_start?.migration_level : envelope.expected_migration_level;
  const lines = [
    `${kind === "staging" ? "Staging release" : "Production Release"} ${releaseId}`,
    `  commit        ${sha} ${subject}`,
  ];
  if (kind === "staging") {
    lines.push(
      `  CI run        ${envelope.ci_run_id}`,
      `  actor         ${envelope.expected_actor}`,
      `  schema level  ${level} (production's starting level)`,
      `  checks        ${list(envelope.required_checks)}`,
      `  deploys       ${list(environmentNames("staging").workers)} (${environmentNames("staging").catalogue}); production is unchanged`,
    );
  } else {
    lines.push(
      `  revision      ${envelope.expected_current_revision_id}`,
      `  schema level  ${level} (before this release's forward migrations)`,
      `  mode          ${envelope.bootstrap === true ? "Bootstrap Mode (empty catalogue)" : `recovery bookmark ${envelope.recovery_bookmark}, backup ${envelope.recovery_backup_attempt_id}`}`,
    );
  }
  // A staging envelope binds production's starting target; staging resolves its own.
  if (kind === "staging") lines.push("  production starting target:");
  lines.push(
    `  account       ${target?.cloudflare_account_id ?? "unknown"}`,
    `  workers       ${list(target?.worker_scripts)}`,
    `  databases     ${databases(target)}`,
  );
  return lines;
}
