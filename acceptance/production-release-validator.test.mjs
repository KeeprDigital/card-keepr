import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateDispatchAndWriteSql } from "../scripts/production-release.mjs";

test("workflow validator accepts only the exact durably prepared plan", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "keepr-release-validator-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const environment = releaseEnvironment();
  await validateDispatchAndWriteSql(environment, directory);
  const preflight = await readFile(join(directory, "preflight.sql"), "utf8");
  const materialize = await readFile(join(directory, "materialize.sql"), "utf8");
  assert.match(preflight, /prepare_production_release/u);
  assert.match(preflight, /production_release_bootstrap/u);
  assert.match(materialize, /'requested'[\s\S]*state='preflight'[\s\S]*state='migrating'/u);

  await assert.rejects(
    validateDispatchAndWriteSql({ ...environment, EXPECTED_CURRENT_REVISION: "catrev-altered" }, join(directory, "altered")),
    /prepared_plan_mismatch/u,
  );
  await assert.rejects(
    validateDispatchAndWriteSql({ ...environment, DISPATCH_DIGEST: "f".repeat(64) }, join(directory, "direct-ui")),
    /dispatch_digest_mismatch/u,
  );
});

function releaseEnvironment() {
  const target = {
    cloudflare_account_id: "0123456789abcdef0123456789abcdef",
    worker_scripts: ["card-keepr-api", "card-keepr-ingestion"],
    d1_databases: [
      { name: "card-keepr-catalogue", id: "00000000-0000-0000-0000-000000000001" },
      { name: "card-keepr-disposable-verification", id: "00000000-0000-0000-0000-000000000002" },
    ],
    r2_buckets: ["card-keepr-evidence", "card-keepr-printing-images", "card-keepr-catalogue-exports", "card-keepr-backups"],
  };
  const retained = ["catrev-current", "catrev-previous", "catrev-old"].map((revision_id, depth) => ({ revision_id, depth, export_verified: true, recovery_verified: true }));
  const smoke = { card_id: "card-1", printing_id: "printing-1" };
  const plan = {
    expected_actor: "keepr-release[bot]", expected_current_revision_id: "catrev-current",
    expected_head_sha: "a".repeat(40), expected_migration_level: 19,
    idempotency_key: "release-47-key", production_target: target,
    production_target_digest: hash(stableJson(target)), recovery_backup_attempt_id: "backup-current",
    recovery_bookmark: "bookmark-current", release_id: "release-47", replacement_handoff: null,
    retained_revision_evidence: retained, smoke_targets: smoke,
  };
  return {
    EXPECTED_ACTOR: plan.expected_actor, EXPECTED_CURRENT_REVISION: plan.expected_current_revision_id,
    EXPECTED_HEAD_SHA: plan.expected_head_sha, EXPECTED_MIGRATION_LEVEL: String(plan.expected_migration_level),
    IDEMPOTENCY_KEY: plan.idempotency_key, PRODUCTION_TARGET_JSON: JSON.stringify(target),
    PRODUCTION_TARGET_DIGEST: plan.production_target_digest,
    RECOVERY_BACKUP_ATTEMPT_ID: plan.recovery_backup_attempt_id, RECOVERY_BOOKMARK: plan.recovery_bookmark,
    RELEASE_ID: plan.release_id, REPLACEMENT_RECOVERY_ID: "none", REPLACEMENT_DATABASE_ID: "none",
    RETAINED_DATABASE_ID: "none", REPLACEMENT_TARGET_DIGEST: "none",
    RETAINED_REVISION_EVIDENCE_JSON: JSON.stringify(retained), SMOKE_TARGETS_JSON: JSON.stringify(smoke),
    PREPARED_PLAN_JSON: stableJson(plan), DISPATCH_DIGEST: hash(stableJson(plan)),
  };
}

function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function stableJson(value) { if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`; if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`; return JSON.stringify(value); }
