import { requiredCiChecks } from "../../../src/http/dev-workflow-identity.mjs";
import type { PublisherScenario } from "./scenario.ts";

const headSha = "a".repeat(40);
const root = "/repos/KeeprDigital/card-keepr";

/** Synthetic GitHub responses behind the real Worker fetch boundary. */
export const githubDevApiMock: PublisherScenario = ({ request, url }) => {
  if (url.hostname !== "api.github.com") return null;
  if (request.headers.get("authorization") !== "Bearer synthetic-dev-github-token")
    return new Response(null, { status: 403 });
  if (url.pathname === `${root}/actions/runs/124`)
    return Response.redirect(`https://api.github.com${root}/actions/runs/123`, 302);
  if (url.pathname === `${root}/actions/runs/123`)
    return Response.json({
      repository: { id: 1313489088 },
      path: ".github/workflows/ci.yml",
      event: "push",
      head_branch: "main",
      head_sha: headSha,
      status: "completed",
      conclusion: "success",
    });
  if (url.pathname === `${root}/compare/main...${headSha}`) return Response.json({ status: "identical" });
  if (url.pathname === `${root}/commits/${headSha}/check-runs`)
    return Response.json({
      total_count: requiredCiChecks.length,
      check_runs: requiredCiChecks.map((name) => ({
        name,
        app: { slug: "github-actions" },
        head_sha: headSha,
        status: "completed",
        conclusion: "success",
      })),
    });
  return new Response(null, { status: 404 });
};
