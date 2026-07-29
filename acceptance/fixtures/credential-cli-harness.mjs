import { appendFileSync } from "node:fs";
import { main } from "../../cli/keepr.mjs";

const code = await main(process.argv.slice(2), process.env, {
  executeCredentialBoundary: async (plan, secrets, environment) => {
    if (environment.KEEPR_TEST_BOUNDARY_LOG) {
      appendFileSync(
        environment.KEEPR_TEST_BOUNDARY_LOG,
        `${JSON.stringify({
          action: plan.action,
          plan_id: plan.id,
          secret_fields: Object.keys(secrets).sort(),
        })}\n`,
      );
    }
    if (environment.KEEPR_TEST_BOUNDARY_FAIL === "1") {
      return {
        ok: false,
        code: "credential_boundary_operation_failed",
        detail: "Injected owning-boundary failure.",
      };
    }
    return {
      ok: true,
      attestation:
        "test-only-injected-boundary-attestation-without-production-key",
    };
  },
});
process.exitCode = code;
