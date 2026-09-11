import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInitialState, transition } from "./administration.mjs";
import { scenarios } from "./scenarios.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const bold = "\x1b[1m";
const dim = "\x1b[2m";
const reset = "\x1b[0m";

for (const file of [
  "openapi.json",
  "schemas/api.schema.json",
  "schemas/catalogue-export-manifest-v5.schema.json",
  "schemas/catalogue-export-record-v5.schema.json",
  "schemas/administration.schema.json"
]) {
  JSON.parse(readFileSync(join(here, "../../contracts", file), "utf8"));
}

let selected = null;
let state = createInitialState();
let actionIndex = 0;

function iso(value) {
  if (typeof value === "number" && value > 1_000_000_000_000) {
    return new Date(value).toISOString();
  }
  return value;
}

function replacer(key, value) {
  if (["now", "started_at", "candidate_created_at", "approval_deadline", "terminal_at", "approved_at", "at"].includes(key)) {
    return iso(value);
  }
  return value;
}

function relevantState(full) {
  const run = full.active_run_id
    ? full.runs[full.active_run_id]
    : Object.values(full.runs).at(-1) ?? null;
  return {
    now: full.now,
    current_revision_id: full.current_revision_id,
    active_run_id: full.active_run_id,
    run: run
      ? {
          id: run.id,
          state: run.state,
          linked_run_id: run.linked_run_id,
          candidate_digest: run.candidate_digest,
          approval_deadline: run.approval_deadline,
          published_revision_id: run.published_revision_id
        }
      : null,
    backups: Object.values(full.backups).map((backup) => ({
      id: backup.id,
      catalogue_revision_id: backup.catalogue_revision_id,
      state: backup.state,
      linked_attempt_id: backup.linked_attempt_id
    })),
    recovery: {
      health: full.recovery.health,
      verified_revision_id: full.recovery.verified_revision_id,
      operation: full.recovery.operation
        ? {
            id: full.recovery.operation.id,
            state: full.recovery.operation.state,
            target_revision_id: full.recovery.operation.target_revision_id
          }
        : null
    },
    release: full.release,
    credential_rotations: Object.values(full.credential_rotations),
    catalogue_exports: Object.values(full.catalogue_exports).map((catalogueExport) => ({
      catalogue_revision_id: catalogueExport.catalogue_revision_id,
      manifest_digest: catalogueExport.manifest_digest,
      object_set_digest: catalogueExport.object_set_digest,
      state: catalogueExport.state,
      deletion_operation_id: catalogueExport.deletion_operation_id,
      deleted_at: catalogueExport.deleted_at
    })),
    export_deletion_plans: Object.values(full.export_deletion_plans).map((plan) => ({
      id: plan.id,
      catalogue_revision_id: plan.catalogue_revision_id,
      manifest_digest: plan.manifest_digest,
      object_set_digest: plan.object_set_digest,
      plan_digest: plan.plan_digest,
      dependencies: plan.dependencies,
      expires_at: plan.expires_at
    })),
    export_deletions: Object.values(full.export_deletions),
    last_transition: full.last_transition
  };
}

function renderMenu() {
  console.clear();
  console.log(`${bold}PROTOTYPE — lifecycle, evidence, and export deletion${reset}`);
  console.log(`${dim}Five JSON artifacts parsed successfully.${reset}\n`);
  console.log(`${bold}Choose a contract scenario${reset}\n`);
  for (const scenario of scenarios) {
    console.log(`  ${bold}[${scenario.key}]${reset} ${scenario.name}`);
  }
  console.log(`\n${bold}[q]${reset} quit`);
}

function renderScenario() {
  console.clear();
  const next = selected.actions[actionIndex];
  console.log(`${bold}${selected.name}${reset}`);
  console.log(`${dim}${selected.question}${reset}`);
  console.log(`\n${bold}Relevant state${reset}`);
  console.log(JSON.stringify(relevantState(state), replacer, 2));
  console.log(`\n${bold}Next event${reset}`);
  console.log(next ? JSON.stringify(next, replacer, 2) : `${dim}Scenario complete.${reset}`);
  console.log(
    `\n${bold}[n]${reset} next event  ${bold}[r]${reset} reset  ${bold}[m]${reset} menu  ${bold}[q]${reset} quit`
  );
}

function selectScenario(key) {
  selected = scenarios.find((scenario) => scenario.key === key) ?? null;
  state = createInitialState();
  actionIndex = 0;
  selected ? renderScenario() : renderMenu();
}

function nextAction() {
  const sourceAction = selected?.actions[actionIndex];
  const action = sourceAction ? structuredClone(sourceAction) : null;
  if (action) {
    if (typeof action.plan_digest === "string" && action.plan_digest.startsWith("$PLAN_DIGEST:")) {
      const planId = action.plan_digest.slice("$PLAN_DIGEST:".length);
      action.plan_digest = state.export_deletion_plans[planId]?.plan_digest ?? action.plan_digest;
    }
    state = transition(state, action);
    actionIndex += 1;
  }
  renderScenario();
}

readFileSync(join(here, "CONTRACT.md"), "utf8");
process.stdin.setEncoding("utf8");
process.stdin.setRawMode?.(true);
process.stdin.resume();
renderMenu();

function handleKey(key) {
  if (key === "q" || key === "\u0003") {
    process.stdin.setRawMode?.(false);
    process.stdout.write("\n");
    process.exit(0);
  }
  if (!selected && scenarios.some((scenario) => scenario.key === key)) {
    selectScenario(key);
  } else if (selected && (key === "n" || key === "\r" || key === "\n")) {
    nextAction();
  } else if (selected && key === "r") {
    selectScenario(selected.key);
  } else if (selected && key === "m") {
    selected = null;
    renderMenu();
  }
}

process.stdin.on("data", (keys) => {
  for (const key of keys) handleKey(key);
});
