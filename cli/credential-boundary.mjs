import { spawn } from "node:child_process";
import { resolve } from "node:path";

const requiredPermissions = {
  api_bearer_key: "workers-secret:api-traffic",
  ingestion_admin_key: "workers-secret:administration",
  d1_export_token: "d1:export",
  d1_verification_token: "d1:edit-disposable",
  github_deployment_token: "workers:deploy",
};

export async function executeCredentialBoundary(
  action,
  identity,
  secret,
  environment,
) {
  const configured = environment.KEEPR_CREDENTIAL_BOUNDARY_EXECUTOR;
  const command = process.execPath;
  const prefix = [
    configured ?? resolve("cli/provider-credential-boundary.mjs"),
  ];
  const arguments_ = [
    ...prefix,
    action,
    identity.credential_class,
    identity.environment,
    identity.resource_identity,
    identity.owning_boundary,
    identity.verification_target,
  ];
  const result = await run(command, arguments_, secret, environment);
  if (result.code !== 0) {
    return {
      ok: false,
      code: "credential_boundary_operation_failed",
      detail: "The owning credential boundary rejected the operation.",
    };
  }
  let document;
  try {
    document = JSON.parse(result.stdout);
  } catch {
    return {
      ok: false,
      code: "invalid_credential_boundary_receipt",
      detail: "The owning credential boundary returned an invalid receipt.",
    };
  }
  const requiredPermission =
    requiredPermissions[identity.credential_class];
  if (
    document?.ok !== true ||
    document.action !== action ||
    document.credential_class !== identity.credential_class ||
    document.environment !== identity.environment ||
    document.resource_identity !== identity.resource_identity ||
    document.owning_boundary !== identity.owning_boundary ||
    document.verification_target !== identity.verification_target ||
    !Array.isArray(document.permissions) ||
    document.permissions.length !== 1 ||
    document.permissions[0] !== requiredPermission ||
    typeof document.receipt !== "string" ||
    !/^receipt:[A-Za-z0-9._:-]{8,200}$/.test(document.receipt)
  ) {
    return {
      ok: false,
      code: "credential_boundary_mismatch",
      detail:
        "The owning credential boundary receipt did not prove the exact class, resource, and least-privilege permission.",
    };
  }
  return { ok: true, receipt: document.receipt };
}

function run(command, arguments_, secret, environment) {
  return new Promise((resolveRun) => {
    const child = spawn(command, arguments_, {
      cwd: process.cwd(),
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    // Boundary stderr is deliberately discarded: provider tools may include
    // request material in diagnostics. Stable CLI errors are emitted instead.
    child.stderr.resume();
    child.once("error", () => {
      resolveRun({ code: 1, stdout: "" });
    });
    child.once("exit", (code) => {
      resolveRun({ code: code ?? 1, stdout });
    });
    child.stdin.end(secret);
  });
}
