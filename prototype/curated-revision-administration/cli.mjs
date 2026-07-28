import {
  createInitialState,
  targetKey,
  transition
} from "./curated-revisions.mjs";
import { runScenario, scenarios } from "./scenarios.mjs";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

let selected = null;
let state = createInitialState();
let stepIndex = 0;

function iso(value) {
  return typeof value === "number" && value > 1_000_000_000_000
    ? new Date(value).toISOString()
    : value;
}

function relevantState(full) {
  return {
    current_revision_id: full.current_revision_id,
    operational: full.operational,
    active_run_id: full.active_run_id,
    runs: Object.values(full.runs).map((run) => ({
      id: run.id,
      state: run.state,
      selected_games: run.selected_games,
      curated_revision_ids: run.curated_revision_ids,
      curated_revision_set_digest: run.curated_revision_set_digest,
      curated_effects: run.curated_effects,
      failure_code: run.failure_code
    })),
    curated_revisions: Object.values(full.revisions).map((revision) => ({
      id: revision.id,
      game: revision.content.game,
      target: targetKey(revision.content),
      assertion: revision.content.assertion,
      content_digest: revision.content_digest,
      status: revision.status,
      event_version: revision.event_version,
      pending_conflict: revision.pending_conflict
    })),
    lifecycle_events: full.events,
    last_transition: full.last_transition
  };
}

function renderMenu() {
  console.clear();
  console.log(`${BOLD}PROTOTYPE — Curated Revision administration${RESET}`);
  console.log(
    `${DIM}Synthetic in-memory state only. Drive the lifecycle and inspect every guard.${RESET}\n`
  );
  for (const scenario of scenarios) {
    console.log(`  ${BOLD}[${scenario.key}]${RESET} ${scenario.name}`);
    console.log(`      ${DIM}${scenario.question}${RESET}`);
  }
  console.log(`\n${BOLD}[q]${RESET} quit`);
}

function renderScenario() {
  console.clear();
  const next = selected.steps[stepIndex];
  console.log(`${BOLD}${selected.name}${RESET}`);
  console.log(`${DIM}${selected.question}${RESET}`);
  console.log(`\n${BOLD}Relevant state${RESET}`);
  console.log(
    JSON.stringify(relevantState(state), (key, value) => iso(value), 2)
  );
  console.log(`\n${BOLD}Next event${RESET}`);
  console.log(
    next
      ? JSON.stringify(
          { action: next.action, expected: next.expected },
          (key, value) => iso(value),
          2
        )
      : `${DIM}Scenario complete.${RESET}`
  );
  console.log(
    `\n${BOLD}[n]${RESET} next  ${BOLD}[r]${RESET} reset  ${BOLD}[m]${RESET} menu  ${BOLD}[q]${RESET} quit`
  );
}

function choose(key) {
  selected = scenarios.find((scenario) => scenario.key === key) ?? null;
  if (!selected) return;
  state = createInitialState(selected.initial);
  stepIndex = 0;
  renderScenario();
}

function advance() {
  const next = selected?.steps[stepIndex];
  if (next) {
    state = transition(state, next.action);
    stepIndex += 1;
  }
  renderScenario();
}

if (!process.stdin.isTTY) {
  const summary = scenarios.map((scenario) => {
    const result = runScenario(scenario);
    return {
      key: scenario.key,
      name: scenario.name,
      passed: result.outcomes.every((outcome) => outcome.matches),
      outcomes: result.outcomes
    };
  });
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.every((scenario) => scenario.passed) ? 0 : 1);
}

process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.resume();
renderMenu();

process.stdin.on("data", (keys) => {
  for (const key of keys) {
    if (key === "q" || key === "\u0003") {
      process.stdin.setRawMode(false);
      process.stdout.write("\n");
      process.exit(0);
    }
    if (!selected && scenarios.some((scenario) => scenario.key === key)) {
      choose(key);
    } else if (selected && (key === "n" || key === "\r" || key === "\n")) {
      advance();
    } else if (selected && key === "r") {
      choose(selected.key);
    } else if (selected && key === "m") {
      selected = null;
      renderMenu();
    }
  }
});
