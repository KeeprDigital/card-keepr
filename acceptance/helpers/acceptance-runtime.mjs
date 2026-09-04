import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");

// Allocate a free 127.0.0.1 port for a local Worker (wrangler dev does not
// accept port 0 itself). `node --test` runs every acceptance file in its own
// process, and processes cannot see each other's allocations, so each process
// owns a partition of a fixed port range derived from its pid and hands out
// ports from that partition only: two concurrently running files never draw
// from the same partition, which removes the bind race between them. The
// range sits below the Linux (32768+) and macOS (49152+) ephemeral ranges so
// outbound connections do not land in it. Each candidate is still probed by
// binding it, so ports another program happens to hold are skipped, and the
// Worker boot retries on a collision as a last resort.
const PORT_RANGE_START = 20_000;
const PORT_RANGE_END = 32_768;
const PORT_PARTITION_SIZE = 64;
const PORT_PARTITIONS = Math.floor(
  (PORT_RANGE_END - PORT_RANGE_START) / PORT_PARTITION_SIZE,
);
const portPartitionStart = PORT_RANGE_START +
  (process.pid % PORT_PARTITIONS) * PORT_PARTITION_SIZE;
const allocatedPorts = new Set();

export function portPartition() {
  return {
    start: portPartitionStart,
    end: portPartitionStart + PORT_PARTITION_SIZE - 1,
  };
}

export async function allocatePort() {
  for (let offset = 0; offset < PORT_PARTITION_SIZE; offset += 1) {
    const port = portPartitionStart + offset;
    if (allocatedPorts.has(port)) continue;
    if (await portFree(port)) {
      allocatedPorts.add(port);
      return port;
    }
  }
  const { start, end } = portPartition();
  throw new Error(
    `No free port remains in this process's partition ${start}-${end}.`,
  );
}

function portFree(port) {
  return new Promise((resolveFree, rejectFree) => {
    const server = createServer();
    server.unref();
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") {
        resolveFree(false);
        return;
      }
      rejectFree(error);
    });
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolveFree(true));
    });
  });
}

// Migrate CATALOGUE_DB under statePath. Running the wrangler CLI costs
// several seconds per boot, so the migrated D1 directory is built once into
// a template shared by every acceptance process on the machine, then copied
// into each fresh statePath. The template is keyed by the migration files
// and the database identity, which every config in this repository shares,
// so per-test config copies reuse it and a changed migration invalidates it.
// A statePath that already holds D1 state is migrated in place instead, so
// callers layering migrations onto restored or seeded state keep the real
// wrangler run.
const migratedTemplates = new Map();
const D1_STATE = join("v3", "d1");
const TEMPLATE_ROOT = join(tmpdir(), "card-keepr-migrated");
const TEMPLATE_WAIT_MS = 120_000;

export async function applyMigrations(statePath, config) {
  const resolvedConfig = config ?? "apps/ingestion/wrangler.jsonc";
  if (existsSync(join(statePath, D1_STATE))) {
    await runMigrations(statePath, resolvedConfig);
    return;
  }
  const key = await templateKey(resolvedConfig);
  let template = migratedTemplates.get(key);
  if (template === undefined) {
    template = ensureMigratedTemplate(key, resolvedConfig);
    migratedTemplates.set(key, template);
  }
  await cp(join(await template, D1_STATE), join(statePath, D1_STATE), {
    recursive: true,
  });
}

async function templateKey(config) {
  const configPath = resolve(root, config);
  const parsed = JSON.parse(await readFile(configPath, "utf8"));
  const database = parsed.d1_databases?.find(
    (entry) => entry.binding === "CATALOGUE_DB",
  );
  assert.ok(database, `${config} does not bind CATALOGUE_DB`);
  const migrationsDir = resolve(
    dirname(configPath),
    database.migrations_dir ?? "migrations",
  );
  const hash = createHash("sha256");
  hash.update(`${database.database_id}\n${database.database_name}\n`);
  for (const name of (await readdir(migrationsDir)).sort()) {
    if (!name.endsWith(".sql")) continue;
    hash.update(`${name}\n`);
    hash.update(await readFile(join(migrationsDir, name)));
    hash.update("\n");
  }
  return hash.digest("hex").slice(0, 32);
}

// Return the shared template directory for key, building it when absent.
// The build lands in a private directory and is renamed into place, so a
// template that exists is always complete; a lock directory lets one process
// build while the others wait for the rename, falling back to building
// themselves if the lock holder disappears.
async function ensureMigratedTemplate(key, config) {
  const template = join(TEMPLATE_ROOT, key);
  if (existsSync(join(template, D1_STATE))) return template;
  await mkdir(TEMPLATE_ROOT, { recursive: true });
  const lock = `${template}.lock`;
  const deadline = Date.now() + TEMPLATE_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      await delay(200);
      if (existsSync(join(template, D1_STATE))) return template;
    }
  }
  try {
    if (existsSync(join(template, D1_STATE))) return template;
    const building = `${template}.building-${process.pid}`;
    await rm(building, { recursive: true, force: true });
    await runMigrations(building, config);
    try {
      await rename(building, template);
    } catch (error) {
      // Another process won the rename; its template is equivalent.
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
      await rm(building, { recursive: true, force: true });
    }
    return template;
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

async function runMigrations(statePath, config) {
  const result = await runProcess(
    resolve(root, "node_modules/.bin/wrangler"),
    [
      "d1", "migrations", "apply", "CATALOGUE_DB", "--local",
      "--config", config,
      "--persist-to", statePath,
    ],
    { ...processEnvironment(statePath), CI: "1" },
  );
  assert.equal(result.code, 0, result.stderr || result.stdout);
}

// Boot a local Worker. Ports are allocated at runtime unless passed, so
// acceptance files can run concurrently. Each file must keep its own
// --persist-to statePath (mkdtemp) so concurrent files never share state;
// workers of one file share a dev registry directory placed beside the
// statePath so cross-process service bindings still resolve, while files
// stay isolated from each other's registries.
//
// pacingMode "immediate" (default) removes the production ~1s-per-fetch
// source host pacing sleep via the SOURCE_HOST_PACING_MODE override read by
// the ingestion Worker; pass "production" to keep production pacing.
export async function startWorker({
  config,
  envFile,
  inspectorPort,
  migrate = false,
  pacingMode = "immediate",
  port,
  registryPath,
  statePath,
  vars = {},
}) {
  if (migrate) await applyMigrations(statePath, config);
  // The probed port is released before wrangler binds it, so another program
  // may still take it first; a boot that dies on that collision retries on
  // fresh ports, and every attempt including the last is checked so a dead
  // Worker is never handed back. A caller-pinned port is never retried:
  // reusing it is the caller's stated intent.
  if (port !== undefined || inspectorPort !== undefined) return spawnWorker();
  const outputs = [];
  for (let attempt = 1; attempt <= BOOT_ATTEMPTS; attempt += 1) {
    const worker = await spawnWorker();
    if (!(await portCollision(worker))) return worker;
    outputs.push(`attempt ${attempt} (port ${worker.port}, inspector ${
      worker.inspectorPort
    }):\n${worker.getOutput()}`);
  }
  throw new Error(
    `${config} could not bind a local port in ${BOOT_ATTEMPTS} attempts\n` +
      outputs.join("\n"),
  );

  async function spawnWorker() {
  const boundPort = port ?? await allocatePort();
  const boundInspectorPort = inspectorPort ?? await allocatePort();
  const boundRegistryPath = registryPath ??
    join(dirname(statePath), "wrangler-registry");
  // The checked-in PUBLIC_BASE_URL mounts each Worker under its production
  // path; the emulated Worker is addressed at its root, so the base is
  // overridden with the bound local origin unless the caller passes one.
  const allVars = {
    SOURCE_HOST_PACING_MODE: pacingMode,
    PUBLIC_BASE_URL: `http://127.0.0.1:${boundPort}`,
    ...vars,
  };
  let output = "";
  const child = spawn(resolve(root, "node_modules/.bin/wrangler"), [
    "dev", "--config", config,
    ...(envFile === undefined ? [] : ["--env-file", envFile]),
    "--local", "--ip", "127.0.0.1", "--port", String(boundPort),
    "--inspector-port", String(boundInspectorPort),
    "--persist-to", statePath,
    ...Object.entries(allVars).flatMap(
      ([key, value]) => ["--var", `${key}:${value}`],
    ),
    "--log-level", "error", "--show-interactive-dev-session", "false",
  ], {
    cwd: root,
    env: {
      ...processEnvironment(statePath),
      WRANGLER_REGISTRY_PATH: boundRegistryPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => output += chunk);
  child.stderr.on("data", (chunk) => output += chunk);
  return {
    process: child,
    getOutput: () => output,
    port: boundPort,
    inspectorPort: boundInspectorPort,
    url: `http://127.0.0.1:${boundPort}`,
  };
  }
}

// Wait briefly for a just-spawned Worker to either hold its port (no
// collision) or exit with an address-collision error; only that early exit
// reports a collision. The error is matched on the EADDRINUSE code and the
// common phrasings wrangler, workerd, and Node have used for it, rather than
// one exact wrangler-version string.
const BOOT_ATTEMPTS = 4;
const BOOT_COLLISION_WINDOW_MS = 5_000;
const ADDRESS_IN_USE = /EADDRINUSE|address (?:is )?already in use|port \S+ is (?:already )?in use/iu;

export function isAddressInUse(output) {
  return ADDRESS_IN_USE.test(output);
}

async function portCollision(worker) {
  const deadline = Date.now() + BOOT_COLLISION_WINDOW_MS;
  while (Date.now() < deadline) {
    if (hasExited(worker.process)) {
      return isAddressInUse(worker.getOutput());
    }
    if (await portHeld(worker.port)) return false;
    await delay(50);
  }
  return false;
}

function portHeld(port) {
  return new Promise((resolveHeld) => {
    const probe = createConnection({ host: "127.0.0.1", port });
    probe.unref();
    probe.once("connect", () => {
      probe.destroy();
      resolveHeld(true);
    });
    probe.once("error", () => resolveHeld(false));
  });
}

export async function waitForResponse(url, worker, description, headers) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (hasExited(worker.process)) {
      throw new Error(`${description} exited\n${worker.getOutput()}`);
    }
    try {
      const response = await fetch(url, { headers });
      if (response.ok) return;
    } catch {
      // The local Worker has not started accepting requests yet.
    }
    await delay(100);
  }
  throw new Error(`${description} did not become ready\n${worker.getOutput()}`);
}

export function waitForHealth(url, key, worker) {
  return waitForResponse(url, worker, "Worker", {
    authorization: `Bearer ${key}`,
  });
}

// Stop a Worker and wait until its process has actually exited, so a
// follow-up boot may safely reuse the same port.
export async function stopWorker(worker) {
  if (hasExited(worker.process)) return;
  const exited = new Promise((resolveExit) =>
    worker.process.once("exit", resolveExit)
  );
  worker.process.kill("SIGTERM");
  await Promise.race([exited, delay(5_000)]);
  if (!hasExited(worker.process)) {
    worker.process.kill("SIGKILL");
    await exited;
  }
}

// Run the repository CLI. "secrets" is delivered as JSON on file descriptor 3,
// matching the --secrets-stdin-fd 3 contract the CLI documents. The
// invocation is killed and reported after timeoutMs (default two minutes).
export function runCli(
  arguments_,
  environment,
  { secrets, stdin, timeoutMs } = {},
) {
  return runProcess(
    process.execPath,
    [resolve(root, "cli/keepr.mjs"), ...arguments_],
    { ...processEnvironment("/tmp"), ...environment },
    { secrets, stdin, timeoutMs },
  );
}

// Apply a SQL file to the local CATALOGUE_DB behind statePath, so a test may
// seed the state a Worker will later serve.
export async function executeSql(statePath, file, config) {
  const result = await runProcess(
    resolve(root, "node_modules/.bin/wrangler"),
    [
      "d1", "execute", "CATALOGUE_DB", "--local",
      "--config", config ?? "apps/ingestion/wrangler.jsonc",
      "--persist-to", statePath,
      "--file", file,
    ],
    { ...processEnvironment(statePath), CI: "1" },
  );
  assert.equal(result.code, 0, result.stderr || result.stdout);
}

// Read an ingestion administration document over HTTP, mirroring the CLI's
// configuration (KEEPR_INGESTION_URL / KEEPR_ADMINISTRATION_KEY /
// KEEPR_TEST_NOW). Returns null while unavailable so poll loops can retry
// without spawning a CLI subprocess per iteration.
export async function administrationDocument(pathname, environment) {
  const base = environment.KEEPR_INGESTION_URL ?? "http://127.0.0.1:8788";
  let response;
  try {
    response = await fetch(new URL(pathname, base), {
      headers: {
        authorization: `Bearer ${environment.KEEPR_ADMINISTRATION_KEY}`,
        ...(environment.KEEPR_TEST_NOW === undefined
          ? {}
          : { "x-keepr-test-now": environment.KEEPR_TEST_NOW }),
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

// Poll an administration document until the predicate accepts it. The
// predicate may return true (done), false (keep polling), or a string
// (fail immediately with that reason).
export async function waitForAdministrationDocument(
  pathname,
  predicate,
  environment,
  worker,
  { deadlineMs = 90_000, pollMs = 250, description = pathname } = {},
) {
  const deadline = Date.now() + deadlineMs;
  let last = null;
  while (Date.now() < deadline) {
    const document = await administrationDocument(pathname, environment);
    if (document !== null) {
      last = document;
      const verdict = predicate(document);
      if (verdict === true) return document;
      if (typeof verdict === "string") {
        throw new Error(
          `${description}: ${verdict}\n${JSON.stringify(document)}\n` +
            worker.getOutput(),
        );
      }
    }
    await delay(pollMs);
  }
  throw new Error(
    `${description} did not reach the expected state\n` +
      `${JSON.stringify(last)}\n${worker.getOutput()}`,
  );
}

// Poll a collection run (CLI equivalent: keepr source show --json) until it
// reaches the expected state. Fails fast when the run reaches "failed"
// unless "failed" is the expected state.
export function waitForRunState(runId, expected, environment, worker, options) {
  return waitForAdministrationDocument(
    `/v1/ingestion-runs/${encodeURIComponent(runId)}/evidence`,
    (document) =>
      document.state === expected ||
      (document.state === "failed" && expected !== "failed"
        ? `run ${runId} failed before reaching ${expected}`
        : false),
    environment,
    worker,
    { description: `run ${runId} → ${expected}`, ...options },
  );
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

// Run a subprocess to completion under a deadline, like the HTTP polling
// helpers above: a CLI or wrangler invocation that hangs is killed and
// reported with its captured output instead of stalling the file until the
// CI job cap. The default covers a cold wrangler migration run; callers with
// a longer legitimate wait pass timeoutMs.
const PROCESS_TIMEOUT_MS = 120_000;

export function runProcess(
  command,
  arguments_,
  environment,
  { secrets, stdin, timeoutMs = PROCESS_TIMEOUT_MS } = {},
) {
  return new Promise((resolveExit, rejectExit) => {
    const child = spawn(command, arguments_, {
      cwd: root,
      env: environment,
      stdio: [
        stdin === undefined ? "ignore" : "pipe",
        "pipe",
        "pipe",
        ...(secrets === undefined ? [] : ["pipe"]),
      ],
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    if (secrets !== undefined) child.stdio[3].end(JSON.stringify(secrets));
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.stderr.on("data", (chunk) => stderr += chunk);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!hasExited(child)) child.kill("SIGKILL");
      }, 5_000).unref();
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectExit(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        rejectExit(new Error(
          `${describeCommand(command, arguments_)} did not exit within ` +
            `${timeoutMs} ms and was killed\nstdout:\n${stdout}\n` +
            `stderr:\n${stderr}`,
        ));
        return;
      }
      resolveExit({ code, stdout, stderr });
    });
  });
}

function describeCommand(command, arguments_) {
  return [command, ...arguments_]
    .map((part) => (part.startsWith(root) ? part.slice(root.length + 1) : part))
    .join(" ");
}

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function processEnvironment(statePath) {
  const environment = { ...process.env };
  delete environment.KEEPR_API_KEY;
  delete environment.KEEPR_ADMINISTRATION_KEY;
  return { ...environment, WRANGLER_LOG_PATH: join(statePath, "logs") };
}
