/** Closed display primitives shared by Worker and CLI health presenters. */
export function safeDiagnosticReference(value) {
  return typeof value === "string" && value.length <= 512 && /^[A-Za-z0-9][A-Za-z0-9_.:@-]*$/u.test(value)
    ? value
    : null;
}

export function safeMachineCode(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,127}$/u.test(value) ? value : null;
}

export function safeDiagnosticCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : "unknown";
}
