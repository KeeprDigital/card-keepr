import type {
  CredentialRotationPlanRow,
} from "../../../src/catalogue/credential-rotation-contracts";
import {
  credentialClassDefinitions,
} from "../../../src/credentials/credential-catalogue.mjs";
import type {
  CredentialConsumerProofRequestClaims,
} from "../../../src/credentials/consumer-proof";
import {
  exactManagementTokenPolicy,
  exactTokenPolicy,
} from "../../../src/credentials/cloudflare-authority.mjs";

type ObservationResponse = {
  status: number;
  body: any;
};
type ObservationContext = {
  expectedStatus?: "usable" | "unusable";
  requiredPermission?: string;
  requiredPermissions?: string[];
  expectedSecrets?: Array<{
    name: string;
    status: "usable" | "unusable";
  }>;
};

export async function observeCloudflareCredentialBoundary(
  plan: CredentialRotationPlanRow,
  observationToken: string,
  request: (
    token: string,
    pathname: string,
    context?: ObservationContext,
  ) => Promise<ObservationResponse | null> = cloudflareJson,
  expected?: Array<
    CredentialConsumerProofRequestClaims & { request_token: string }
  >,
): Promise<unknown[] | null> {
  if (
    observationToken.length < 20 ||
    !/^[0-9a-f]{32}$/.test(plan.cloudflare_account_id)
  ) {
    return null;
  }
  const definition = credentialClassDefinitions[plan.credential_class];
  if (definition === undefined) return null;
  const observations: unknown[] = [];

  if (definition.issuer_provider === "consumer-secret") {
    const requests = expected ?? [];
    const expectedSecrets = requests.map((proofRequest) => ({
      name:
        proofRequest.slot === "a"
          ? definition.slot_a_secret_name
          : definition.slot_b_secret_name,
      status: proofRequest.expected_status,
    }));
    const listed = await request(
      observationToken,
      `/accounts/${plan.cloudflare_account_id}/workers/scripts/` +
        `${definition.consumer_worker_name}/secrets`,
      { expectedSecrets },
    );
    const names = listed?.body?.result;
    if (
      listed?.status !== 200 ||
      listed.body?.success !== true ||
      !Array.isArray(names) ||
      !names.every((item: any) => typeof item?.name === "string")
    ) {
      return null;
    }
    const present = new Set(names.map((item: any) => item.name));
    for (const proofRequest of requests) {
      const name =
        proofRequest.slot === "a"
          ? definition.slot_a_secret_name
          : definition.slot_b_secret_name;
      if (
        (proofRequest.expected_status === "usable") !==
          present.has(name)
      ) {
        return null;
      }
      observations.push({
        contract: "cloudflare-worker-secret-observation@1",
        worker: definition.consumer_worker_name,
        secret_name: name,
        status: proofRequest.expected_status,
      });
    }
  } else {
    const issuerChecks = expected ?? issuerChecksFromPlan(plan);
    for (const check of issuerChecks) {
      const issuerId = check.replacement_issuer_credential_id;
      const observed = await request(
        observationToken,
        `/accounts/${plan.cloudflare_account_id}/tokens/` +
          encodeURIComponent(issuerId),
        {
          expectedStatus: check.expected_status,
          requiredPermission: plan.required_permission,
        },
      );
      if (check.expected_status === "unusable") {
        if (
          observed?.status !== 404 ||
          observed.body?.success !== false
        ) {
          return null;
        }
      } else {
        const token = observed?.body?.result;
        if (
          observed?.status !== 200 ||
          observed.body?.success !== true ||
          token?.id !== issuerId ||
          token?.status !== "active" ||
          !exactTokenPolicy(
            token,
            plan.required_permission,
            plan.cloudflare_account_id,
          )
        ) {
          return null;
        }
      }
      observations.push({
        contract: "cloudflare-token-observation@1",
        issuer_credential_id: issuerId,
        status: check.expected_status,
        required_permission: plan.required_permission,
        cloudflare_account_id: plan.cloudflare_account_id,
      });
    }
  }

  if (
    typeof plan.management_credential_id === "string" &&
    plan.management_credential_id.length > 0
  ) {
    let required: unknown;
    try {
      required = JSON.parse(
        plan.cloudflare_management_required_permissions,
      );
    } catch {
      return null;
    }
    const management = await request(
      observationToken,
      `/accounts/${plan.cloudflare_account_id}/tokens/` +
        encodeURIComponent(plan.management_credential_id),
      {
        expectedStatus: "usable",
        requiredPermissions: required as string[],
      },
    );
    const token = management?.body?.result;
    if (
      management?.status !== 200 ||
      management.body?.success !== true ||
      token?.id !== plan.management_credential_id ||
      token?.status !== "active" ||
      !exactManagementTokenPolicy(
        token,
        required,
        plan.cloudflare_account_id,
      )
    ) {
      return null;
    }
    observations.push({
      contract: "cloudflare-management-token-observation@1",
      issuer_credential_id: plan.management_credential_id,
      permissions: required,
    });
  }
  return observations;
}

function issuerChecksFromPlan(plan: CredentialRotationPlanRow): Array<{
  expected_status: "usable" | "unusable";
  replacement_issuer_credential_id: string;
}> {
  return [
    {
      expected_status: "usable",
      replacement_issuer_credential_id:
        plan.replacement_issuer_credential_id,
    },
    ...(plan.action === "verify"
      ? [{
          expected_status: "usable" as const,
          replacement_issuer_credential_id:
            plan.old_issuer_credential_id,
        }]
      : []),
    ...(plan.action === "revoke"
      ? [{
          expected_status: "unusable" as const,
          replacement_issuer_credential_id:
            plan.old_issuer_credential_id,
        }]
      : []),
  ];
}

async function cloudflareJson(
  token: string,
  pathname: string,
  context: ObservationContext = {},
): Promise<ObservationResponse | null> {
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4${pathname}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          ...(context.expectedStatus === undefined
            ? {}
            : {
                "x-keepr-observation-expected-status":
                  context.expectedStatus,
              }),
          ...(context.requiredPermission === undefined
            ? {}
            : {
                "x-keepr-observation-required-permission":
                  context.requiredPermission,
              }),
          ...(context.requiredPermissions === undefined
            ? {}
            : {
                "x-keepr-observation-required-permissions":
                  context.requiredPermissions.join(","),
              }),
          ...(context.expectedSecrets === undefined
            ? {}
            : {
                "x-keepr-observation-expected-secrets":
                  JSON.stringify(context.expectedSecrets),
              }),
        },
        signal: AbortSignal.timeout(15_000),
      },
    );
    return {
      status: response.status,
      body: await response.json(),
    };
  } catch {
    return null;
  }
}
