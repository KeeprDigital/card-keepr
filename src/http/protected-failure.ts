import type { OperationalRuntime } from "./operational-log";

type FailureClassification = "sql_failure" | "missing_object" | "programming_fault" | "unexpected_error";

/** Only closed classifications and opaque stack fingerprints leave this boundary.
 * Never serialize an exception: messages, custom properties, names and paths can
 * all contain credentials or retained Source Snapshot bodies.
 */
export async function logProtectedFailure(
  runtime: OperationalRuntime,
  requestId: string,
  error: unknown,
): Promise<void> {
  const causes: { classification: FailureClassification; stack_reference: string | null }[] = [];
  const seen = new Set<unknown>();
  let current = error;
  try {
    while (causes.length < 4 && !seen.has(current)) {
      seen.add(current);
      causes.push({ classification: classify(current), stack_reference: await stackReference(current) });
      current = ownValue(current, "cause");
      if (current === undefined) break;
    }
    console.error(
      JSON.stringify({
        contract: "card-keepr-protected-failure@1",
        event: "request.failed",
        runtime,
        request_id: requestId,
        causes,
        cause_chain_truncated: current !== undefined,
      }),
    );
  } catch {
    // Diagnostic infrastructure must not turn a generic problem into an uncaught
    // exception (which the platform could log with its unredacted message).
  }
}

function ownValue(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  try {
    return Object.getOwnPropertyDescriptor(value, key)?.value;
  } catch {
    return undefined;
  }
}

function classify(error: unknown): FailureClassification {
  if (ownValue(error, "code") === "NoSuchKey" || ownValue(error, "code") === "missing_object") return "missing_object";
  const message = ownValue(error, "message");
  const prefix = typeof message === "string" ? message.slice(0, 256) : "";
  if (/^D1_(?:ERROR|EXEC_ERROR|COLUMN_NOTFOUND):/.test(prefix) || /^SQLITE_[A-Z_]+:/.test(prefix)) return "sql_failure";
  if (
    error instanceof TypeError ||
    error instanceof ReferenceError ||
    error instanceof SyntaxError ||
    error instanceof RangeError
  )
    return "programming_fault";
  return "unexpected_error";
}

async function stackReference(error: unknown): Promise<string | null> {
  let stack: unknown;
  try {
    stack = error instanceof Error ? error.stack : ownValue(error, "stack");
  } catch {
    return null;
  }
  if (typeof stack !== "string") return null;
  // Ignore message lines; retain only bounded V8 frame locations. The hash is
  // for grouping the same failure site, never a recoverable copy of a stack.
  const frames = stack
    .slice(0, 8192)
    .split("\n")
    .filter((line) => /^\s+at /.test(line))
    .slice(0, 8)
    .join("\n");
  if (!frames) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(frames));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
