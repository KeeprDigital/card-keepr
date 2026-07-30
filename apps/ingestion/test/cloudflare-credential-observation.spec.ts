import { describe, expect, test } from "vitest";
import {
  observeCloudflareCredentialBoundary,
} from "../src/cloudflare-credential-observation";

const accountId = "0123456789abcdef0123456789abcdef";
const exactPolicy = (permission = "D1 Read", account = accountId) => ({
  id: "provider-token:new",
  status: "active",
  policies: [{
    effect: "allow",
    permission_groups: [{ name: permission }],
    resources: {
      [`com.cloudflare.api.account.${account}`]: "*",
    },
  }],
});

const plan = {
  credential_class: "d1_export_token",
  cloudflare_account_id: accountId,
  required_permission: "D1 Read",
  replacement_issuer_credential_id: "provider-token:new",
  old_issuer_credential_id: "provider-token:old",
  action: "install",
};

describe("server-owned Cloudflare boundary observation", () => {
  test("accepts only the exact replacement issuer and exact least-privilege policy", async () => {
    const observe = (token: unknown) =>
      observeCloudflareCredentialBoundary(
        plan as never,
        "server-owned-observation-token",
        async (_token, pathname) =>
          pathname.endsWith("/provider-token%3Anew")
            ? { status: 200, body: { success: true, result: token } }
            : { status: 404, body: { success: false } },
      );

    await expect(observe(exactPolicy())).resolves.not.toBeNull();
    await expect(observe({
      ...exactPolicy(),
      policies: [
        ...exactPolicy().policies,
        {
          effect: "allow",
          permission_groups: [{ name: "Workers Scripts Write" }],
          resources: {
            [`com.cloudflare.api.account.${accountId}`]: "*",
          },
        },
      ],
    })).resolves.toBeNull();
    await expect(observe({
      ...exactPolicy(),
      id: "provider-token:attacker",
    })).resolves.toBeNull();
    await expect(observe(
      exactPolicy("D1 Read", "ffffffffffffffffffffffffffffffff"),
    )).resolves.toBeNull();
  });

  test("revoke requires authoritative old-issuer deletion, not merely a deleted consumer secret", async () => {
    const revoke = {
      ...plan,
      action: "revoke",
    };
    const observed = await observeCloudflareCredentialBoundary(
      revoke as never,
      "server-owned-observation-token",
      async (_token, pathname) =>
        pathname.endsWith("/provider-token%3Aold")
          ? {
              status: 200,
              body: {
                success: true,
                result: {
                  ...exactPolicy(),
                  id: "provider-token:old",
                },
              },
            }
          : {
              status: 200,
              body: { success: true, result: exactPolicy() },
            },
    );
    expect(observed).toBeNull();
  });
});
