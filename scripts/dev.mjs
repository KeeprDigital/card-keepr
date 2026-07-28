import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const wrangler = resolve(root, "node_modules/.bin/wrangler");
const projects = [
  {
    name: "api",
    config: "apps/api/wrangler.jsonc",
    port: "8787",
    inspectorPort: "9229",
  },
  {
    name: "ingestion",
    config: "apps/ingestion/wrangler.jsonc",
    port: "8788",
    inspectorPort: "9230",
  },
];
const children = projects.map((project) => {
  const child = spawn(
    wrangler,
    [
      "dev",
      "--config",
      project.config,
      "--port",
      project.port,
      "--inspector-port",
      project.inspectorPort,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        WRANGLER_LOG_PATH: resolve(root, ".wrangler/logs"),
      },
      stdio: "inherit",
    },
  );
  child.once("exit", (code, signal) => {
    if (!stopping) {
      process.stderr.write(
        `${project.name} Worker stopped (${signal ?? `exit ${code}`})\n`,
      );
      stop(code ?? 1);
    }
  });
  return child;
});

let stopping = false;
function stop(exitCode) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  process.exitCode = exitCode;
}

process.once("SIGINT", () => stop(0));
process.once("SIGTERM", () => stop(0));
