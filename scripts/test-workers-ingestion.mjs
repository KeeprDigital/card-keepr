import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vitest = resolve(repositoryRoot, "node_modules/vitest/vitest.mjs");
const config = "apps/ingestion/vitest.config.ts";
const testDirectory = "apps/ingestion/test";
const contextual = "apps/ingestion/test/contextual-legality.spec.ts";
const reconciliation = "apps/ingestion/test/reconciliation.spec.ts";
const runtime = "apps/ingestion/test/runtime.spec.ts";
const contextualSource = readFileSync(resolve(repositoryRoot, contextual), "utf8");
const runtimeSource = readFileSync(resolve(repositoryRoot, runtime), "utf8");
const reconciliationSource = readFileSync(
  resolve(repositoryRoot, reconciliation),
  "utf8",
);

const tasks = readdirSync(resolve(repositoryRoot, testDirectory))
  .filter((name) => name.endsWith(".spec.ts"))
  .map((name) => `${testDirectory}/${name}`)
  .filter((path) =>
    path !== contextual && path !== reconciliation && path !== runtime
  )
  .map((path) => ({
    arguments: ["run", "--config", config, path],
    label: path,
  }));

const runtimePatterns = testDeclarationTitlePatterns(runtimeSource);
if (runtimePatterns.length !== 48) {
  throw new Error(
    `Expected 48 runtime test declarations, found ${runtimePatterns.length}.`,
  );
}
const runtimeShardCount = 8;
for (let shard = 0; shard < runtimeShardCount; shard += 1) {
  const patterns = runtimePatterns.filter(
    (_, index) => index % runtimeShardCount === shard,
  );
  tasks.push({
    arguments: [
      "run",
      "--config",
      config,
      runtime,
      "--testNamePattern",
      `^(?:${patterns.join("|")})$`,
    ],
    label: `runtime shard ${shard + 1}/${runtimeShardCount}`,
  });
}

const contextualMatrixPrefix =
  "a versioned production adapter blocks official wording it cannot represent exactly: ";
const contextualMatrixStart = contextualSource.indexOf(
  'test.each([\n  "card-keepr-mixed-modeled-unmodeled-legality-v3"',
);
const contextualLateStart = contextualSource.indexOf(
  '\ntest("same-URL legality observations',
  contextualMatrixStart,
);
const contextualFinalStart = contextualSource.indexOf(
  '\ntest("test-owned domain evidence',
  contextualLateStart,
);
if (
  contextualMatrixStart < 0 ||
  contextualLateStart < 0 ||
  contextualFinalStart < 0
) {
  throw new Error("The contextual legality suite boundaries could not be found.");
}
const contextualEarlyPatterns = testDeclarationTitlePatterns(
  contextualSource.slice(0, contextualMatrixStart),
);
const contextualLatePatterns = testDeclarationTitlePatterns(
  contextualSource.slice(contextualLateStart, contextualFinalStart),
);
const contextualFinalPatterns = testDeclarationTitlePatterns(
  contextualSource.slice(contextualFinalStart),
);
if (
  contextualEarlyPatterns.length !== 10 ||
  contextualLatePatterns.length !== 11 ||
  contextualFinalPatterns.length !== 8
) {
  throw new Error(
    "The contextual legality stateful shard declarations changed; update the runner boundaries.",
  );
}
tasks.push({
  arguments: [
    "run",
    "--config",
    config,
    contextual,
    "--testNamePattern",
    `^(?:${contextualEarlyPatterns.join("|")})$`,
  ],
  label: "contextual legality (early stateful cases)",
});
const contextualMarkers = contextualMatrixMarkers(
  contextualSource.slice(contextualMatrixStart, contextualLateStart),
);
const contextualShardCount = 5;
for (let shard = 0; shard < contextualShardCount; shard += 1) {
  const patterns = contextualMarkers
    .filter((_, index) => index % contextualShardCount === shard)
    .map((marker) => escapeRegex(`${contextualMatrixPrefix}${marker}`));
  tasks.push({
    arguments: [
      "run",
      "--config",
      config,
      contextual,
      "--testNamePattern",
      `^(?:${patterns.join("|")})$`,
    ],
    label: `contextual legality matrix shard ${shard + 1}/${contextualShardCount}`,
  });
}
tasks.push({
  arguments: [
    "run",
    "--config",
    config,
    contextual,
    "--testNamePattern",
    `^(?:${contextualLatePatterns.join("|")})$`,
  ],
  label: "contextual legality (late source-change cases)",
});
tasks.push({
  arguments: [
    "run",
    "--config",
    config,
    contextual,
    "--testNamePattern",
    `^(?:${contextualFinalPatterns.join("|")})$`,
  ],
  label: "contextual legality (final stateful cases)",
});

const titles = reconciliationTestTitlePatterns(reconciliationSource);
const shardCount = 8;
const reconciliationTasks = [];
for (let shard = 0; shard < shardCount; shard += 1) {
  const patterns = titles.filter((_, index) => index % shardCount === shard);
  reconciliationTasks.push({
    arguments: [
      "run",
      "--config",
      config,
      reconciliation,
      "--testNamePattern",
      `^(?:${patterns.join("|")})$`,
    ],
    label: `reconciliation shard ${shard + 1}/${shardCount}`,
  });
}

// Each task owns a fresh Workerd process. Two processes keep the suite bounded
// without sharing Workflow or D1 state.
await runTasks(tasks, 2);
// Reconciliation shards each exercise Workflow-backed backup verification and
// must not compete for Workerd's polling deadlines.
await runTasks(reconciliationTasks, 1);

function contextualMatrixMarkers(source) {
  const arrayStart = source.indexOf("[") + 1;
  const arrayEnd = source.indexOf(
    '])("a versioned production adapter blocks official wording it cannot represent exactly: %s"',
  );
  if (arrayStart === 0 || arrayEnd < 0) {
    throw new Error("The contextual legality matrix could not be located.");
  }
  const block = source.slice(arrayStart, arrayEnd);
  const markers = [...block.matchAll(/"((?:[^"\\]|\\.)*)"/gu)]
    .map((match) => JSON.parse(`"${match[1]}"`));
  if (markers.length !== 25) {
    throw new Error(
      `Expected 25 contextual legality matrix cases, found ${markers.length}.`,
    );
  }
  return markers;
}

function reconciliationTestTitlePatterns(source) {
  const patterns = testDeclarationTitlePatterns(source);
  if (patterns.length !== 99) {
    throw new Error(
      `Expected 99 reconciliation test declarations, found ${patterns.length}.`,
    );
  }
  return patterns;
}

function testDeclarationTitlePatterns(source) {
  const stringLiteral = String.raw`("(?:[^"\\]|\\.)*")`;
  const ordinary = [...source.matchAll(
    new RegExp(String.raw`^test\(\s*${stringLiteral}`, "gms"),
  )].map((match) => escapeRegex(JSON.parse(match[1])));
  const parameterized = [...source.matchAll(
    new RegExp(
      String.raw`^test\.each\(\[[\s\S]*?\]\)\(\s*${stringLiteral}`,
      "gm",
    ),
  )].map((match) => parameterizedTitlePattern(JSON.parse(match[1])));
  const declaredOrdinary = [...source.matchAll(/^test\(/gmu)].length;
  const declaredParameterized = [...source.matchAll(/^test\.each\(/gmu)].length;
  if (
    ordinary.length !== declaredOrdinary ||
    parameterized.length !== declaredParameterized
  ) {
    throw new Error(
      "A test declaration could not be converted into a title pattern.",
    );
  }
  return [...ordinary, ...parameterized];
}

function parameterizedTitlePattern(title) {
  return title
    .split(/(\$[A-Za-z_][A-Za-z0-9_]*|%[sdifjo])/u)
    .map((part) => /^\$|^%/u.test(part) ? ".+" : escapeRegex(part))
    .join("");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function runTasks(tasksToRun, concurrency) {
  let nextTask = 0;
  let failed = false;
  async function worker() {
    while (!failed && nextTask < tasksToRun.length) {
      const task = tasksToRun[nextTask];
      nextTask += 1;
      const status = await runVitest(task.arguments, task.label);
      if (status !== 0) failed = true;
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  if (failed) process.exit(1);
}

function runVitest(arguments_, label) {
  console.log(`\n[ingestion tests] ${label}`);
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [vitest, ...arguments_], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        VITE_CONFIG_NATIVE_IGNORE_WARNING: "true",
      },
      stdio: "inherit",
    });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        console.error(`[ingestion tests] ${label} stopped by ${signal}`);
        resolveRun(1);
        return;
      }
      resolveRun(code ?? 1);
    });
  });
}
