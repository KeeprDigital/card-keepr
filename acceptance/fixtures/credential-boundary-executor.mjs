import { createHash } from "node:crypto";

const [
  action,
  credentialClass,
  environment,
  resourceIdentity,
  owningBoundary,
  verificationTarget,
] = process.argv.slice(2);
let secret = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) secret += chunk;

const permissions = {
  api_bearer_key: "workers-secret:api-traffic",
  ingestion_admin_key: "workers-secret:administration",
  d1_export_token: "d1:export",
  d1_verification_token: "d1:edit-disposable",
  github_deployment_token: "workers:deploy",
};
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
    permissions: [permissions[credentialClass]],
    receipt: `receipt:test:${receipt}`,
  })}\n`,
);
