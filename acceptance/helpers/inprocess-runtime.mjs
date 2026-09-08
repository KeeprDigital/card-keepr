import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { after } from "node:test";
import { inspect, parseEnv } from "node:util";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { unstable_getMiniflareWorkerOptions, unstable_splitSqlQuery } from "wrangler";
import { profileNativeIsolates } from "./native-isolate-metrics.mjs";
import { appliedMigrations, createMigrationLedger, recordMigration } from "./query-helpers/migrations.mjs";

const root = resolve(import.meta.dirname, "../..");
const groups = new Map();
const bundles = new Map();
let profileSequence = 0;

// A setup failure can occur before a test installs its per-handle cleanup.
// The file-level hook still closes any runtime created before that failure.
after(async () => {
  for (const group of groups.values()) {
    await Promise.all([...group.handles].map((handle) => handle.dispose()));
    if (group.runtime && !group.disposing) await group.runtime.dispose();
  }
  groups.clear();
});

function identity(statePath, id) {
  return `${id}-${createHash("sha256").update(resolve(statePath)).digest("hex").slice(0, 16)}`;
}

function persistence(statePath) {
  const path = join(dirname(resolve(statePath)), "miniflare");
  return { d1Persist: join(path, "d1"), r2Persist: join(path, "r2"), workflowsPersist: join(path, "workflows") };
}

export function inprocessDatabaseDirectory(statePath) {
  return persistence(statePath).d1Persist;
}

async function configuration(config, statePath) {
  const path = resolve(root, config);
  const raw = JSON.parse(await readFile(path, "utf8"));
  const converted = await unstable_getMiniflareWorkerOptions(path);
  const options = converted.workerOptions;
  for (const kind of ["d1Databases", "r2Buckets"]) {
    options[kind] = Object.fromEntries(
      Object.entries(options[kind] ?? {}).map(([binding, value]) => [
        binding,
        { ...value, id: identity(statePath, typeof value === "string" ? value : value.id) },
      ]),
    );
  }
  return { raw, path, ...converted, workerOptions: options };
}

function pendingServices(workers) {
  const names = new Set(workers.keys());
  const pending = new Set();
  for (const worker of workers.values()) {
    for (const binding of Object.values(worker.serviceBindings ?? {})) {
      const name = typeof binding === "string" ? binding : binding.name;
      if (name && !names.has(name)) pending.add(name);
    }
  }
  return [...pending].map((name) => ({
    name,
    modules: true,
    compatibilityDate: "2026-07-29",
    script: "export default { fetch() { return new Response('Acceptance service has not started', {status: 503}); } }",
  }));
}

// Bundle each configured entrypoint once; test-specific wrappers remain explicit.
async function bundle(main, define) {
  const key = JSON.stringify([main, define]);
  if (!bundles.has(key)) {
    bundles.set(
      key,
      build({
        entryPoints: [main],
        bundle: true,
        write: false,
        format: "esm",
        platform: "neutral",
        mainFields: ["browser", "module", "main"],
        conditions: ["workerd", "worker", "browser"],
        target: "es2022",
        external: ["cloudflare:*", "node:*"],
        loader: { ".html": "text", ".txt": "text", ".sql": "text", ".bin": "binary" },
        define,
      }).then((result) => result.outputFiles[0].text),
    );
  }
  return bundles.get(key);
}

export async function startInprocessWorker({
  config,
  envFile,
  outboundService,
  pacingMode,
  port,
  registryPath,
  statePath,
  vars,
}) {
  const key = registryPath ?? dirname(resolve(statePath));
  let group = groups.get(key);
  if (!group) {
    group = {
      workers: new Map(),
      handles: new Set(),
      serial: Promise.resolve(),
      options: persistence(statePath),
      output: "",
    };
    groups.set(key, group);
  }
  const prepared = await configuration(config, statePath);
  const secrets = envFile ? parseEnv(await readFile(envFile, "utf8")) : {};
  const options = {
    ...prepared.workerOptions,
    name: prepared.raw.name,
    ...(outboundService ? { outboundService } : {}),
    modules: true,
    script: await bundle(prepared.main, prepared.define),
    bindings: {
      ...prepared.workerOptions.bindings,
      ...secrets,
      SOURCE_HOST_PACING_MODE: pacingMode,
      PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      ...vars,
    },
  };
  const server = createServer(async (request, response) => {
    try {
      await group.serial;
      // Carry original headers as data past Miniflare's localhost CSRF filter.
      // Fetch stays asynchronous: a first RPC call can block Node in Atomics.wait
      // while workerd blocks on the operational-log pipe that Node must drain.
      // The application itself receives the original Origin, including malformed values.
      const worker = await group.runtime.getWorker("acceptance-http-bridge");
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = ["GET", "HEAD"].includes(request.method) ? undefined : Buffer.concat(chunks);
      const result = await worker.fetch("http://acceptance-bridge.invalid/dispatch", {
        method: "POST",
        headers: {
          "x-acceptance-dispatch": encodeURIComponent(
            JSON.stringify({
              name: options.name,
              url: `http://127.0.0.1:${port}${request.url}`,
              method: request.method,
              headers: request.headers,
            }),
          ),
        },
        body,
      });
      response.writeHead(result.status, Object.fromEntries(result.headers));
      if (result.body) for await (const chunk of result.body) response.write(chunk);
      response.end();
    } catch (error) {
      group.output += `[acceptance-http-bridge] ${request.method} ${request.url}\n${inspect(error, { depth: 4 })}\n`;
      response.writeHead(500).end(String(error));
    }
  });
  group.serial = group.serial.then(async () => {
    group.workers.set(options.name, options);
    const all = {
      ...group.options,
      ...(process.env.KEEPR_CAPACITY_OUTPUT_PREFIX ? { inspectorPort: 0 } : {}),
      handleRuntimeStdio: (stdout, stderr) => {
        for (const stream of [stdout, stderr])
          stream.on("data", (chunk) => {
            group.output += chunk.toString();
          });
      },
      workers: [
        ...group.workers.values(),
        ...pendingServices(group.workers),
        {
          name: "acceptance-http-bridge",
          modules: true,
          compatibilityDate: "2026-07-29",
          script: `import { WorkerEntrypoint } from "cloudflare:workers";
        export default class extends WorkerEntrypoint {
          async fetch(request) {
            const { name, url, method, headers } = JSON.parse(decodeURIComponent(request.headers.get("x-acceptance-dispatch")));
            return this.env[name].fetch(url, {
              method, headers, body: method === "GET" || method === "HEAD" ? undefined : request.body,
            });
          }
        }`,
          serviceBindings: Object.fromEntries([...group.workers.keys()].map((name) => [name, name])),
        },
      ],
    };
    if (group.stopProfile) {
      await group.stopProfile();
      group.stopProfile = undefined;
    }
    if (group.runtime) await group.runtime.setOptions(all);
    else group.runtime = new Miniflare(all);
    await group.runtime.ready;
    if (process.env.KEEPR_CAPACITY_OUTPUT_PREFIX) {
      const offset = group.output.length;
      group.stopProfile = await profileNativeIsolates(
        group.runtime,
        `${process.env.KEEPR_CAPACITY_OUTPUT_PREFIX}-isolate-${++profileSequence}.json`,
        { directory: dirname(resolve(statePath)), output: () => group.output.slice(offset) },
      );
    }
  });
  await group.serial;
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", done);
  });
  const administrationLimit = options.ratelimits?.ADMINISTRATION_RATE_LIMIT?.simple;
  const handle = {
    administrationPollIntervalMs: administrationLimit
      ? Math.ceil((administrationLimit.period * 1000) / (administrationLimit.limit * 0.8))
      : undefined,
    port,
    url: `http://127.0.0.1:${port}`,
    getOutput: () => group.output,
    closed: false,
    async dispose() {
      if (handle.closed) return;
      handle.closed = true;
      await new Promise((done) => server.close(done));
      group.handles.delete(handle);
      if (group.handles.size === 0) {
        if (group.stopProfile) {
          await group.stopProfile();
          group.stopProfile = undefined;
        }
        group.disposing ??= group.runtime.dispose();
        await group.disposing;
        groups.delete(key);
      }
    },
  };
  group.handles.add(handle);
  return handle;
}

async function withDatabase(statePath, config, callback) {
  const prepared = await configuration(config ?? "apps/ingestion/wrangler.jsonc", statePath);
  const group = [...groups.values()].find((entry) =>
    [...entry.workers.values()].some(
      (worker) => worker.d1Databases?.CATALOGUE_DB?.id === prepared.workerOptions.d1Databases.CATALOGUE_DB.id,
    ),
  );
  if (group) {
    await group.serial;
    const worker = [...group.workers.values()].find(
      (entry) => entry.d1Databases?.CATALOGUE_DB?.id === prepared.workerOptions.d1Databases.CATALOGUE_DB.id,
    );
    return callback(await group.runtime.getD1Database("CATALOGUE_DB", worker.name), prepared);
  }
  const runtime = new Miniflare({
    ...persistence(statePath),
    modules: true,
    script: "export default { fetch() { return new Response('fixture database'); } }",
    compatibilityDate: prepared.workerOptions.compatibilityDate,
    d1Databases: prepared.workerOptions.d1Databases,
  });
  try {
    return await callback(await runtime.getD1Database("CATALOGUE_DB"), prepared);
  } finally {
    await runtime.dispose();
  }
}

export function executeInprocessSql(statePath, file, config) {
  return withDatabase(statePath, config, async (database) => {
    const sql = unstable_splitSqlQuery(await readFile(file, "utf8"));
    await database.batch(sql.map((statement) => database.prepare(statement)));
  });
}

export function applyInprocessMigrations(statePath, config, testMigrations = []) {
  return withDatabase(statePath, config, async (database, prepared) => {
    const binding = prepared.raw.d1_databases.find((entry) => entry.binding === "CATALOGUE_DB");
    const directory = resolve(dirname(prepared.path), binding.migrations_dir ?? "migrations");
    await createMigrationLedger(database).run();
    const applied = new Set((await appliedMigrations(database).all()).results.map((row) => row.name));
    for (const name of (await readdir(directory)).filter((entry) => entry.endsWith(".sql")).sort()) {
      if (applied.has(name)) continue;
      const statements = unstable_splitSqlQuery(await readFile(join(directory, name), "utf8"));
      await database.batch([
        ...statements.map((statement) => database.prepare(statement)),
        recordMigration(database, name),
      ]);
    }
    for (const migration of testMigrations) {
      if (applied.has(migration.name)) continue;
      await database.batch([
        ...migration.queries.map((statement) => database.prepare(statement)),
        recordMigration(database, migration.name),
      ]);
    }
  });
}
