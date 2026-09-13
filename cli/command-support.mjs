export function parseOptions(arguments_, valueOptions, flagOptions = ["--json"]) {
  const values = {};
  const flags = new Set();
  for (let index = 0; index < arguments_.length; index += 1) {
    const option = arguments_[index];
    if (flagOptions.includes(option) || option === "--json") {
      if (flags.has(option)) return { error: "duplicate", values, flags };
      flags.add(option);
      continue;
    }
    if (!valueOptions.includes(option) || values[option] !== undefined) {
      return { error: "unknown", values, flags };
    }
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return { error: "missing", values, flags };
    }
    values[option] = value;
    index += 1;
  }
  return { error: null, values, flags };
}

// KEEPR_API_URL and KEEPR_INGESTION_URL are base URLs that may carry a path
// (issue #123: https://card.keepr.digital/api and /ingest). `new URL(path,
// base)` discards a base path, so route paths are appended to the base.
export function runtimeUrl(base, path) {
  if (!path.startsWith("/")) {
    throw new Error(`Route path ${JSON.stringify(path)} must start with "/"`);
  }
  return new URL(`${String(base).replace(/\/+$/u, "")}${path}`);
}

export function writeCliFailure(json, failure, exitCode) {
  if (json) {
    const document = {
      contract: "card-keepr-cli-problem@1",
      status: "error",
      code: failure.code,
      detail: failure.detail,
      ...(failure.runtime ? { runtime: failure.runtime } : {}),
    };
    process.stdout.write(`${JSON.stringify(document)}\n`);
  } else {
    process.stderr.write(`${failure.detail}\n`);
  }
  return exitCode;
}

export function exitCodeForStatus(status) {
  if (status === 401) return 4;
  if (status === 403) return 5;
  if (status === 404) return 6;
  if (status === 409) return 7;
  if (status === 400 || status === 413 || status === 422) return 8;
  return 9;
}

export function targetConfirmationDetail(action, environment) {
  return `${action} requires --environment ${environment.KEEPR_TARGET ?? "production"}.`;
}
