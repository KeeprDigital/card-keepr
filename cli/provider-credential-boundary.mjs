import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const [
  action,
  credentialClass,
  environment,
  resourceIdentity,
  owningBoundary,
  verificationTarget,
] = process.argv.slice(2);
const secret = await readStdin();

const operations = {
  api_bearer_key: {
    resource: "worker:card-keepr-api",
    boundary: "api_worker",
    target: "worker-health:card-keepr-api",
    install: [
      "wrangler",
      [
        "secret",
        "put",
        "API_BEARER_KEY_REPLACEMENT",
        "--config",
        "apps/api/wrangler.jsonc",
      ],
    ],
    revoke: {
      provider: "wrangler",
      name: "API_BEARER_KEY",
      config: "apps/api/wrangler.jsonc",
    },
    permission: "workers-secret:api-traffic",
  },
  ingestion_admin_key: {
    resource: "worker:card-keepr-ingestion",
    boundary: "ingestion_worker",
    target: "worker-health:card-keepr-ingestion",
    install: [
      "wrangler",
      [
        "secret",
        "put",
        "ADMINISTRATION_KEY_REPLACEMENT",
        "--config",
        "apps/ingestion/wrangler.jsonc",
      ],
    ],
    revoke: {
      provider: "wrangler",
      name: "ADMINISTRATION_KEY",
      config: "apps/ingestion/wrangler.jsonc",
    },
    permission: "workers-secret:administration",
  },
  d1_export_token: {
    resource: "d1:card-keepr-catalogue",
    boundary: "d1_export_operation",
    target: "cloudflare:d1:card-keepr-catalogue:export",
    install: [
      "wrangler",
      [
        "secret",
        "put",
        "D1_EXPORT_TOKEN_REPLACEMENT",
        "--config",
        "apps/ingestion/wrangler.jsonc",
      ],
    ],
    revoke: {
      provider: "wrangler",
      name: "D1_EXPORT_TOKEN",
      config: "apps/ingestion/wrangler.jsonc",
    },
    probe: "d1-export",
    permission: "d1:export",
  },
  d1_verification_token: {
    resource: "d1:disposable-verification",
    boundary: "disposable_verification",
    target: "cloudflare:d1:disposable-verification:edit",
    install: [
      "wrangler",
      [
        "secret",
        "put",
        "D1_VERIFICATION_TOKEN_REPLACEMENT",
        "--config",
        "apps/ingestion/wrangler.jsonc",
      ],
    ],
    revoke: {
      provider: "wrangler",
      name: "D1_VERIFICATION_TOKEN",
      config: "apps/ingestion/wrangler.jsonc",
    },
    probe: "d1-disposable",
    permission: "d1:edit-disposable",
  },
  github_deployment_token: {
    resource: "worker-release:card-keepr",
    boundary: "production_release_workflow",
    target: "github:KeeprDigital/card-keepr:environment:production",
    install: [
      "gh",
      [
        "secret",
        "set",
        "CLOUDFLARE_DEPLOYMENT_TOKEN_REPLACEMENT",
        "--repo",
        "KeeprDigital/card-keepr",
        "--env",
        "production",
      ],
    ],
    revoke: {
      provider: "github",
      name: "CLOUDFLARE_DEPLOYMENT_TOKEN",
    },
    probe: "worker-release",
    permission: "workers:deploy",
  },
};

const operation = operations[credentialClass];
if (
  operation === undefined ||
  environment !== "production" ||
  resourceIdentity !== operation.resource ||
  owningBoundary !== operation.boundary ||
  verificationTarget !== operation.target ||
  !["install", "verify", "revoke", "probe-old"].includes(action)
) {
  process.exitCode = 2;
} else {
  const code =
    action === "verify" || action === "probe-old"
      ? await probe(operation.probe, secret)
      : action === "revoke"
        ? await revoke(operation.revoke)
        : await run(...operation.install, secret);
  if (code !== 0) {
    process.exitCode = code;
  } else {
    const receipt = createHash("sha256")
      .update(
        [
          action,
          credentialClass,
          environment,
          resourceIdentity,
          owningBoundary,
          verificationTarget,
          createHash("sha256").update(secret).digest("hex"),
        ].join("\0"),
      )
      .digest("hex");
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        action,
        credential_class: credentialClass,
        environment,
        resource_identity: resourceIdentity,
        owning_boundary: owningBoundary,
        verification_target: verificationTarget,
        permissions: [operation.permission],
        receipt: `receipt:${receipt}`,
      })}\n`,
    );
  }
}

async function probe(kind, token) {
  const childEnvironment = {
    ...process.env,
    CLOUDFLARE_API_TOKEN: token,
  };
  if (kind === "d1-export") {
    const directory = await mkdtemp(
      join(tmpdir(), "keepr-credential-probe-"),
    );
    try {
      return await run(
        "wrangler",
        [
          "d1",
          "export",
          "card-keepr-catalogue",
          "--remote",
          "--no-data",
          "--output",
          join(directory, "probe.sql"),
          "--config",
          "apps/ingestion/wrangler.jsonc",
        ],
        "",
        childEnvironment,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  if (kind === "d1-disposable") {
    return run(
      "wrangler",
      [
        "d1",
        "execute",
        "disposable-verification",
        "--remote",
        "--command",
        "SELECT 1 AS credential_probe",
        "--json",
        "--config",
        "apps/ingestion/wrangler.jsonc",
      ],
      "",
      childEnvironment,
    );
  }
  if (kind === "worker-release") {
    const api = await run(
      "wrangler",
      [
        "deployments",
        "list",
        "--name",
        "card-keepr-api",
        "--config",
        "apps/api/wrangler.jsonc",
      ],
      "",
      childEnvironment,
    );
    if (api !== 0) return api;
    return run(
      "wrangler",
      [
        "deployments",
        "list",
        "--name",
        "card-keepr-ingestion",
        "--config",
        "apps/ingestion/wrangler.jsonc",
      ],
      "",
      childEnvironment,
    );
  }
  return 9;
}

async function revoke(removal) {
  if (removal.provider === "wrangler") {
    const listed = await capture(
      "wrangler",
      [
        "secret",
        "list",
        "--format",
        "json",
        "--config",
        removal.config,
      ],
      "",
    );
    if (listed.code !== 0) return listed.code;
    let secrets;
    try {
      secrets = JSON.parse(listed.stdout);
    } catch {
      return 9;
    }
    if (
      !Array.isArray(secrets) ||
      !secrets.some((item) => item?.name === removal.name)
    ) {
      return 0;
    }
    return run(
      "wrangler",
      [
        "secret",
        "delete",
        removal.name,
        "--config",
        removal.config,
      ],
      "",
    );
  }

  const listed = await capture(
    "gh",
    [
      "secret",
      "list",
      "--repo",
      "KeeprDigital/card-keepr",
      "--env",
      "production",
      "--json",
      "name",
    ],
    "",
  );
  if (listed.code !== 0) return listed.code;
  let secrets;
  try {
    secrets = JSON.parse(listed.stdout);
  } catch {
    return 9;
  }
  if (
    !Array.isArray(secrets) ||
    !secrets.some((item) => item?.name === removal.name)
  ) {
    return 0;
  }
  return run(
    "gh",
    [
      "secret",
      "delete",
      removal.name,
      "--repo",
      "KeeprDigital/card-keepr",
      "--env",
      "production",
    ],
    "",
  );
}

function run(command, arguments_, input, environment = process.env) {
  return new Promise((resolveRun) => {
    const child = spawn(command, arguments_, {
      cwd: process.cwd(),
      env: environment,
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.once("error", () => resolveRun(9));
    child.once("exit", (code) => resolveRun(code ?? 9));
    child.stdin.end(input);
  });
}

function capture(command, arguments_, input) {
  return new Promise((resolveRun) => {
    const child = spawn(command, arguments_, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.once("error", () => resolveRun({ code: 9, stdout: "" }));
    child.once("exit", (code) => {
      resolveRun({ code: code ?? 9, stdout });
    });
    child.stdin.end(input);
  });
}

async function readStdin() {
  let value = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) value += chunk;
  return value;
}
