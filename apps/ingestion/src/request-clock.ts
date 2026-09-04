import type { PublicationBackupWaiter } from "../../../src/catalogue/ingestion";
import { AdministrationProblem } from "../../../src/catalogue/shared";

export function administrationObservedAt(request: Request, env: Env): string {
  const requested = request.headers.get("x-keepr-test-now");
  const clockMode: string = env.ADMINISTRATION_CLOCK_MODE;
  if (clockMode !== "request" || requested === null) {
    return new Date().toISOString();
  }
  const parsed = new Date(requested);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== requested) {
    throw new AdministrationProblem(422, "invalid_parameter", "x-keepr-test-now must be a canonical UTC timestamp.");
  }
  return requested;
}

/** The request-clock harness may await backup completion; production only awaits dispatch. */
export function publicationBackupWaiter(env: Pick<Env, "ADMINISTRATION_CLOCK_MODE">): PublicationBackupWaiter {
  if (String(env.ADMINISTRATION_CLOCK_MODE) !== "request") return async () => {};
  return async (initial, observe) => {
    let observed = initial;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (observed.status === "complete" || observed.status === "dispatch_failed" || observed.status === "unknown")
        return;
      await new Promise((resolve) => setTimeout(resolve, 10));
      observed = await observe();
    }
    throw new Error("Publication backup did not complete in the test observation window.");
  };
}
