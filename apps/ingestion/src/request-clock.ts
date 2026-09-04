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
