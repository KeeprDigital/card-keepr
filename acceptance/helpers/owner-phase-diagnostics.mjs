// [DEBUG-323-owner-phase] Temporary, opt-in, metadata-only hosted diagnostic.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const directory = process.env.KEEPR_OWNER_PHASE_DIAGNOSTICS;
const slot = Number(process.env.KEEPR_OWNER_PHASE_SLOT ?? 0);
const enabled = Boolean(directory) && Number.isInteger(slot) && slot >= 0 && slot <= 32;
const started = performance.now();
const totals = new Map();
let journalBytes = 0;
let journalCapped = false;
let cliSlots = 0;
let lastStarted = null;
let lastCompleted = null;
let stageStarted;
let stageCpu;
const rounded = (value) => Math.round(value * 1000) / 1000;
const parentJournalLimit = 60 * 1024 - 1024;

if (enabled) mkdirSync(directory, { recursive: true });

function snapshot() {
  if (!enabled || slot) return;
  const value =
    JSON.stringify({
      elapsed_ms: rounded(performance.now() - started),
      last_started: lastStarted,
      last_completed: lastCompleted,
      cli_slots: cliSlots,
      pacing: totals.get("pacing") ?? null,
      journal_capped: journalCapped,
    }) + "\n";
  if (Buffer.byteLength(value) <= 1024) writeFileSync(join(directory, "latest.json"), value);
}

function record(value) {
  if (!enabled || slot) return;
  const line = JSON.stringify({ at_ms: rounded(performance.now() - started), ...value }) + "\n";
  if (journalBytes + Buffer.byteLength(line) <= parentJournalLimit) {
    appendFileSync(join(directory, "phases.jsonl"), line);
    journalBytes += Buffer.byteLength(line);
  } else {
    journalCapped = true;
  }
  snapshot();
}

function begin(group, label, events) {
  const start = performance.now();
  const cpu = process.cpuUsage();
  if (events) record({ event: "started", group, label });
  return (completed) => {
    const wall = performance.now() - start;
    const used = process.cpuUsage(cpu);
    const aggregate = totals.get(group) ?? { count: 0, wall_ms: 0, cpu_user_ms: 0, cpu_system_ms: 0 };
    aggregate.count++;
    aggregate.wall_ms = rounded(aggregate.wall_ms + wall);
    aggregate.cpu_user_ms = rounded(aggregate.cpu_user_ms + used.user / 1000);
    aggregate.cpu_system_ms = rounded(aggregate.cpu_system_ms + used.system / 1000);
    totals.set(group, aggregate);
    if (events)
      record({
        event: "settled",
        group,
        label,
        completed,
        wall_ms: rounded(wall),
        cpu_user_ms: rounded(used.user / 1000),
        cpu_system_ms: rounded(used.system / 1000),
      });
  };
}

export function phaseSync(group, label, action) {
  if (!enabled) return action();
  const end = begin(group, label, true);
  let completed = false;
  try {
    const value = action();
    completed = true;
    return value;
  } finally {
    end(completed);
  }
}

export async function phaseAsync(group, label, action, events = true) {
  if (!enabled) return action();
  const end = begin(group, label, events);
  let completed = false;
  try {
    const value = await action();
    completed = true;
    return value;
  } finally {
    end(completed);
  }
}

export function ownerStage(name) {
  if (!enabled || slot) return;
  if (lastStarted !== null) {
    lastCompleted = lastStarted;
    const cpu = process.cpuUsage(stageCpu);
    record({
      event: "owner-completed",
      stage: lastCompleted,
      wall_ms: rounded(performance.now() - stageStarted),
      cpu_user_ms: rounded(cpu.user / 1000),
      cpu_system_ms: rounded(cpu.system / 1000),
    });
  }
  lastStarted = name;
  stageStarted = performance.now();
  stageCpu = process.cpuUsage();
  record({ event: "owner-started", stage: name });
}

export function ownerComplete() {
  if (!enabled || slot || lastStarted === null) return;
  lastCompleted = lastStarted;
  const cpu = process.cpuUsage(stageCpu);
  record({
    event: "owner-completed",
    stage: lastCompleted,
    wall_ms: rounded(performance.now() - stageStarted),
    cpu_user_ms: rounded(cpu.user / 1000),
    cpu_system_ms: rounded(cpu.system / 1000),
  });
}

export function childPhaseEnvironment() {
  if (!enabled || slot) return {};
  cliSlots++;
  // At most 32 child reports of 128 bytes, plus 60 KiB parent data: 64 KiB total.
  if (cliSlots > 32) return { KEEPR_OWNER_PHASE_DIAGNOSTICS: "", KEEPR_OWNER_PHASE_SLOT: "" };
  return { KEEPR_OWNER_PHASE_DIAGNOSTICS: directory, KEEPR_OWNER_PHASE_SLOT: String(cliSlots) };
}

if (enabled)
  process.once("exit", () => {
    if (slot) {
      const pacing = totals.get("pacing");
      const value =
        JSON.stringify({
          slot,
          n: pacing?.count ?? 0,
          ms: Math.round(pacing?.wall_ms ?? 0),
          cpu: Math.round((pacing?.cpu_user_ms ?? 0) + (pacing?.cpu_system_ms ?? 0)),
        }) + "\n";
      writeFileSync(
        join(directory, `cli-${slot}.json`),
        Buffer.byteLength(value) <= 128 ? value : JSON.stringify({ slot, capped: true }),
      );
    } else {
      record({
        event: "process-exit",
        totals: Object.fromEntries(totals),
        last_started: lastStarted,
        last_completed: lastCompleted,
      });
    }
  });
