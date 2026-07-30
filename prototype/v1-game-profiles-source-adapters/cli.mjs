import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  evaluateScenario,
  validatePrintingIdentityContract,
} from "./contract.mjs";
import { scenarios } from "./scenarios.mjs";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const here = dirname(fileURLToPath(import.meta.url));

validatePrintingIdentityContract(
  readFileSync(join(here, "CONTRACT.md"), "utf8"),
);

let selected = null;

function render() {
  console.clear();
  console.log(`${BOLD}PROTOTYPE — v1 Game Profiles and source-adapter contracts${RESET}`);
  console.log(
    `${DIM}Synthetic observations only. Inspect whether each outcome matches the intended contract.${RESET}\n`
  );

  if (selected) {
    console.log(`${BOLD}${selected.key}. ${selected.name}${RESET}`);
    console.log(`${selected.question}\n`);
    console.log(`${BOLD}Input${RESET}`);
    console.log(JSON.stringify(selected.input, null, 2));
    console.log(`\n${BOLD}Contract outcome${RESET}`);
    console.log(JSON.stringify(evaluateScenario(selected), null, 2));
  } else {
    console.log(`${BOLD}Scenarios${RESET}`);
    for (const scenario of scenarios) {
      console.log(`  ${BOLD}[${scenario.key}]${RESET} ${scenario.name}`);
      console.log(`      ${DIM}${scenario.question}${RESET}`);
    }
  }

  console.log(`\n${BOLD}[1-9,0]${RESET} inspect  ${BOLD}[a]${RESET} all  ${BOLD}[m]${RESET} menu  ${BOLD}[q]${RESET} quit`);
}

function renderAll() {
  console.clear();
  const summary = scenarios.map((scenario) => {
    const result = evaluateScenario(scenario);
    return {
      key: scenario.key,
      name: scenario.name,
      outcome: result.publication ?? result.result.outcome,
      diagnostics: (result.diagnostics ?? result.result.diagnostics ?? []).map(
        ({ severity, code }) => `${severity}:${code}`
      )
    };
  });
  console.log(`${BOLD}All scenario outcomes${RESET}\n`);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\n${BOLD}[m]${RESET} menu  ${BOLD}[q]${RESET} quit`);
}

if (!process.stdin.isTTY) {
  const summary = scenarios.map((scenario) => ({
    name: scenario.name,
    result: evaluateScenario(scenario)
  }));
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");

process.stdin.on("data", (key) => {
  if (key === "q" || key === "\u0003") process.exit(0);
  if (key === "m") {
    selected = null;
    render();
    return;
  }
  if (key === "a") {
    renderAll();
    return;
  }
  const scenario = scenarios.find((candidate) => candidate.key === key);
  if (scenario) {
    selected = scenario;
    render();
  }
});

render();
