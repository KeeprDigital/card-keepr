/** A required retained object is absent; never attach its key or source body. */
export class MissingObjectError extends Error {
  readonly code = "missing_object";

  constructor() {
    super("A required retained object is absent.");
  }
}
