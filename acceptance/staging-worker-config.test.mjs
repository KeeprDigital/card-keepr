import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readWorkerConfig } from "../cli/lib/config.mjs";
import { stagingAudience } from "../src/http/dev-workflow-identity.mjs";

// The staging ingestion Worker verifies an owner's staging intent by fetching
// production's authorization route over public HTTPS (staging-deployment.ts).
// Both Workers live on the keepr.digital zone. Without this compatibility
// flag Cloudflare routes a same-zone fetch() to the zone's origin, which is the
// 100:: placeholder, so production's Worker never sees the request and staging
// reports staging_authorization_refused (observed 2026-09-21, #237).
test("the ingestion Worker routes same-zone fetches through the public front door", async () => {
  const config = await readWorkerConfig("apps/ingestion/wrangler.jsonc");
  assert.ok(Array.isArray(config.compatibility_flags));
  assert.ok(
    config.compatibility_flags.includes("global_fetch_strictly_public"),
    "apps/ingestion/wrangler.jsonc must declare global_fetch_strictly_public",
  );
  const source = await readFile("src/catalogue/ingestion/staging-deployment.ts", "utf8");
  assert.match(source, /fetch\(stagingAudience,/u);
  assert.equal(new URL(stagingAudience).hostname, "card.keepr.digital");
});
