import { existsSync } from "node:fs";
import { copyFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const wrangler = resolve(root, "node_modules/.bin/wrangler");
const check = process.argv.includes("--check");
const projects = ["api", "ingestion"];

for (const project of projects) {
  const directory = resolve(root, "apps", project);
  const localVariables = resolve(directory, ".dev.vars");
  const createdVariables = !existsSync(localVariables);
  if (createdVariables) {
    await copyFile(resolve(directory, ".dev.vars.example"), localVariables);
  }

  try {
    await run([
      "types",
      resolve(directory, "worker-configuration.d.ts"),
      "--config",
      resolve(directory, "wrangler.jsonc"),
      ...(check ? ["--check"] : []),
    ]);
  } finally {
    if (createdVariables) {
      await rm(localVariables, { force: true });
    }
  }
}

function run(arguments_) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(wrangler, arguments_, {
      cwd: root,
      env: {
        ...process.env,
        WRANGLER_LOG_PATH: resolve(root, ".wrangler/logs"),
      },
      stdio: "inherit",
    });
    child.once("error", rejectRun);
    child.once("exit", (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`wrangler types exited with code ${code}`));
    });
  });
}
