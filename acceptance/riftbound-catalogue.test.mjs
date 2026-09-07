import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { nativeExportReader } from "./helpers/native-export-reader.mjs";
import { acceptedBackupRetry, resumeExistingBackupAttempt } from "./helpers/native-backup-retry.mjs";
import { riftboundReplayTransport } from "./helpers/riftbound-replay-transport.mjs";
import { verifiedBackupApiState } from "./helpers/verified-backup-api-state.mjs";
import {
  applyMigrations,
  runCli as runUnpacedCli,
  startWorker,
  stopWorker,
  waitForHealth,
  waitForAdministrationDocument,
} from "./helpers/acceptance-runtime.mjs";
import {
  paceNativeRequest,
  nativeCheckpointTransport,
  publishNativeCollection,
} from "./helpers/native-catalogue-runtime.mjs";

async function runCli(args, environment, options) {
  await paceNativeRequest(environment);
  return runUnpacedCli(args, environment, options);
}

// Actual retained HTTP bodies. External HTTP and Cloudflare control plane are
// replayed locally; collection, parsing and all owner operations are shipped code.
test("retained Riot catalogue: owner reviews, publishes and restores English inventory, Errata and Products", async (t) => {
  const startedAt = performance.now();
  const exportReader = nativeExportReader(250);
  const nativeExportRecords = exportReader.records;
  const resumeDirectory = process.env.KEEPR_RIFTBOUND_RESUME_DIRECTORY;
  const resumeRunId = process.env.KEEPR_RIFTBOUND_RESUME_RUN_ID;
  const resumePublicationId = process.env.KEEPR_RIFTBOUND_RESUME_PUBLICATION_ID;
  assert.ok(!resumePublicationId || resumeDirectory, "Published resume requires retained run state");
  assert.equal(Boolean(resumeDirectory), Boolean(resumeRunId), "Resume requires both retained directory and run id");
  const directory = resumeDirectory ? resolve(resumeDirectory) : await mkdtemp(join(tmpdir(), "keepr-real-riftbound-"));
  if (resumeDirectory) t.diagnostic(`Resuming retained run ${resumeRunId}; original collection is not repeated.`);
  const statePath = join(directory, "state");
  const pack = resolve("acceptance/fixtures/real-sources/2026-09-06");
  const previous = JSON.parse(await readFile(join(pack, "manifest.json"), "utf8"));
  const currentPack = resolve("acceptance/fixtures/real-sources/2026-09-08-riftbound");
  const current = JSON.parse(await readFile(join(currentPack, "manifest.json"), "utf8"));
  const manifest = {
    captures: [
      ...previous.captures
        .filter((c) => c.id.startsWith("riftbound-image-") || ["riftbound-errata", "riftbound-products"].includes(c.id))
        .map((c) => ({ ...c, root: pack })),
      ...current.captures.map((c) => ({ ...c, root: currentPack })),
    ],
  };
  const captures = new Map(
    await Promise.all(
      manifest.captures.map(async (c) => [c.url, { ...c, bodyBytes: await readFile(join(c.root, c.body)) }]),
    ),
  );
  const config = JSON.parse(await readFile("apps/ingestion/wrangler.jsonc", "utf8"));
  delete config.$schema;
  config.main = resolve("apps/ingestion/src/index.ts");
  config.d1_databases[0].migrations_dir = resolve("migrations");
  const configPath = join(directory, "ingestion.json");
  await writeFile(configPath, JSON.stringify(config));
  if (!resumeDirectory) await applyMigrations(statePath);
  const checkpoint = await nativeCheckpointTransport(t, statePath, directory, configPath);
  const key = crypto.randomUUID();
  const served = [];
  const worker = await startWorker({
    ...checkpoint,
    config: configPath,
    statePath,
    vars: { ...checkpoint.vars, ADMINISTRATION_KEY: key, SOURCE_HOST_PACING_MODE: "immediate" },
    outboundService: riftboundReplayTransport(checkpoint, captures, served),
  });
  let api, restoredAdmin;
  let journeyCompleted = false;
  t.after(async () => {
    if (api) await stopWorker(api);
    if (restoredAdmin) await stopWorker(restoredAdmin);
    await stopWorker(worker);
    if (journeyCompleted && !resumeDirectory) await rm(directory, { recursive: true, force: true });
    else t.diagnostic(`Native replay state retained at ${directory}`);
  });
  await waitForHealth(`${worker.url}/health`, key, worker);
  const environment = {
    KEEPR_INGESTION_URL: worker.url,
    KEEPR_ADMINISTRATION_KEY: key,
    KEEPR_NATIVE_REQUEST_INTERVAL_MS: "2200",
  };
  const cli = async (args) => {
    const result = await runCli([...args, "--json"], environment);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    return JSON.parse(result.stdout);
  };
  const planPath = join(directory, "plan.json");
  let run = resumeRunId ? { id: resumeRunId } : null;
  if (!resumeDirectory) {
    for (const area of ["card_facts", "printing_details", "corrected_card_content"])
      await cli([
        "source",
        "designate",
        "--game",
        "riftbound",
        "--locale",
        "en",
        "--release-region",
        "US",
        "--area",
        area,
        "--source-lineage",
        "riftbound-en",
        "--expected-generation",
        "0",
        "--rationale",
        "Use retained Riot evidence for this English catalogue replay.",
        "--idempotency-key",
        `riot-authority-${area}`,
      ]);
    await writeFile(
      planPath,
      JSON.stringify({
        plans: [
          {
            supported_game: "riftbound",
            source_lineage: "riftbound-en",
            adapter_version: "riftbound-en@1",
            subset: "complete",
            requests: [
              { id: "riftbound-en:catalogue", url: current.captures[0].url },
              { id: "riftbound-en:errata", url: previous.captures.find((c) => c.id === "riftbound-errata").url },
              { id: "riftbound-en:products", url: previous.captures.find((c) => c.id === "riftbound-products").url },
            ],
          },
        ],
      }),
    );
    const collected = await runCli(
      ["source", "collect", "--plan-file", planPath, "--idempotency-key", "real-riftbound", "--json"],
      environment,
    );
    assert.equal(collected.code, 0, `${collected.stdout} ${collected.stderr}\n${worker.getOutput()}`);
    run = JSON.parse(collected.stdout);
    const resumed = await runCli(["source", "resume", "--run-id", run.id, "--json"], environment);
    assert.equal(resumed.code, 0, resumed.stderr);
    await waitForAdministrationDocument(
      `/v1/ingestion-runs/${run.id}/evidence`,
      (d) => d.state === "parsing" || (["failed", "paused"].includes(d.state) ? JSON.stringify(d) : false),
      environment,
      worker,
      { deadlineMs: 600_000 },
    );
    await waitForAdministrationDocument(
      `/v1/ingestion-runs/${run.id}/game-candidates`,
      (d) =>
        d.candidates.some((c) => c.state === "paused")
          ? JSON.stringify(d)
          : d.candidates.length > 0 && d.candidates.every((c) => ["sealed", "failed"].includes(c.state)),
      environment,
      worker,
      { deadlineMs: 600_000 },
    );
  }
  const shown = await runCli(["source", "show", "--run-id", run.id, "--json"], environment);
  assert.equal(shown.code, 0, shown.stdout);
  const evidence = JSON.parse(shown.stdout);
  assert.deepEqual(evidence.evidence_plans[0].coverage, {
    locale: "en",
    area: "catalogue",
    subset: "complete",
  });
  assert.equal(evidence.snapshots.length, 14);
  for (const snapshot of evidence.snapshots)
    assert.equal(snapshot.content.digest, captures.get(snapshot.request.url).sha256);
  assert.equal(
    evidence.observation_sets.reduce((sum, set) => sum + set.observation_count, 0),
    1229,
  );
  const proposals = [];
  const ownerProposals = [];
  let after = null;
  do {
    const result = await runCli(
      ["entity-proposal", "list", "--game", "riftbound", ...(after ? ["--after", after] : []), "--json"],
      environment,
    );
    assert.equal(result.code, 0, result.stdout);
    const page = JSON.parse(result.stdout);
    proposals.push(...page.proposals.filter((p) => p.source_lineage === "riftbound-en"));
    ownerProposals.push(...page.proposals.filter((p) => p.source_lineage === "owner"));
    after = page.next_cursor;
  } while (after);
  assert.equal(proposals.length, 1189);
  assert.equal(new Set(proposals.map((p) => p.id)).size, 1189);
  if (!resumeDirectory) {
    assert.deepEqual(
      [...new Set(served)].sort(),
      [
        ...current.captures.filter((c) => c.id.startsWith("riftbound-cards-")).map((c) => c.id),
        ...previous.captures.filter((c) => c.id.startsWith("riftbound-image-")).map((c) => c.id),
        "riftbound-errata",
        "riftbound-products",
      ].sort(),
    );
  }
  const intake = resumePublicationId ? { candidates: [] } : await cli(["game-candidate", "list", "--run-id", run.id]);
  // Missing Erratum targets may fail the first preparation. Retain that
  // diagnostic; explicit Card admission below must make the next one publish.
  for (const candidate of intake.candidates.filter((c) => c.state === "sealed"))
    await cli([
      "game-candidate",
      "abandon",
      "--candidate-id",
      candidate.id,
      "--generation",
      String(candidate.generation),
      "--idempotency-key",
      `retain-intake-${candidate.id}`,
      "--yes",
    ]);
  const reviewed = [
    ["ogn-001-298", "Blazing Scorcher: red frame, Noxus/Dragon unit, 5 energy and 5 might, OGN-001/298."],
    ["ogn-066a-298", "Ahri, Alluring: arcade alternate artwork, green Calm frame, AHRI/IONIA, OGN-066a/298."],
    ["ogn-067-298", "Blitzcrank, Impassive: extended metal-robot artwork, BLITZCRANK/ZAUN/MECH, OGN-067/298."],
    [
      "ogn-141-298",
      "Kinkou Monk: original printed buff two wording, Body frame, OGN-141/298. Printed wording is independent of corrected gallery text.",
    ],
    [
      "sfd-227-star-221",
      "Ahri, Inquisitive: signature-style pink artwork and gold border, AHRI/IONIA printed tags, SFD-227*/221. Gallery omits Ionia; this admission does not approve that omission as printed evidence.",
    ],
    [
      "unl-205-219",
      "Abandoned Hall: landscape battlefield, duplicated inverted text on one front, UNL-205/219. No reverse face established.",
    ],
  ];
  const admittedPrintings = new Map();
  const admittedCards = new Map();
  const decisionPath = join(directory, "decision.json");
  for (const [locator, evidenceText] of reviewed) {
    const proposal = proposals.find((p) => JSON.parse(p.reference)[0] === locator);
    assert.ok(proposal, locator);
    await writeFile(
      decisionPath,
      JSON.stringify({
        expected_generation: "0",
        idempotency_key: `review-${locator}`,
        rationale: evidenceText,
        exception: {
          scope: ["identity"],
          attestation: `Visual review of retained 2026-09-06 Riot image: ${evidenceText} Physical finish remains unknown.`,
        },
      }),
    );
    const admitted = resumePublicationId
      ? await cli(["entity-proposal", "inspect", "--proposal-id", proposal.id])
      : await cli(["entity-proposal", "admit", "--proposal-id", proposal.id, "--decision", decisionPath, "--yes"]);
    assert.equal(admitted.status, "admitted");
    admittedPrintings.set(locator, admitted.history[0].decision.printing.id);
    admittedCards.set(admitted.history[0].decision.card.name, admitted.history[0].decision.card.id);
  }
  const erratumTargets = [
    "Ava Achiever",
    "Baited Hook",
    "Blind Fury",
    "Clockwork Keeper",
    "Convergent Mutation",
    "Dark Child - Starter",
    "Dazzling Aurora",
    "Disintegrate",
    "Dragon's Rage",
    "Dune Drake",
    "Highlander",
    "Karma, Channeler",
    "Kinkou Monk",
    "Nocturne, Horrifying",
    "Pack of Wonders",
    "Portal Rescue",
    "Promising Future",
    "Ravenborn Tome",
    "Salvage",
    "Sigil of the Storm",
    "Sona, Harmonious",
    "Targon's Peak",
    "Teemo, Strategist",
    "The Boss",
    "The Dreaming Tree",
    "The Syren",
    "Tideturner",
    "Unforgiven",
    "Unlicensed Armory",
    "Void Gate",
    "Zhonya's Hourglass",
  ];
  const gallery = (
    await Promise.all(
      current.captures
        .filter((c) => c.id.startsWith("riftbound-cards-"))
        .map(async (c) => JSON.parse(await readFile(join(currentPack, c.body), "utf8")).data),
    )
  ).flat();
  const proposalPath = join(directory, "owner-card.json");
  for (const name of erratumTargets.filter((name) => !admittedCards.has(name))) {
    if (resumePublicationId) {
      const prior = ownerProposals.find((p) => p.reference === `origins-target:${name}`);
      assert.ok(prior, name);
      const admitted = await cli(["entity-proposal", "inspect", "--proposal-id", prior.id]);
      assert.equal(admitted.status, "admitted");
      assert.equal(admitted.history[0].decision.printing, null);
      admittedCards.set(name, admitted.history[0].decision.card.id);
      continue;
    }
    const record = gallery.find((r) => r.name === name && (name !== "Karma, Channeler" || r.id.startsWith("sfd-")));
    assert.ok(record, name);
    const source = proposals.find((p) => JSON.parse(p.reference)[0] === record.id);
    assert.ok(source, record.id);
    const inspected = await cli(["entity-proposal", "inspect", "--proposal-id", source.id]);
    await writeFile(
      proposalPath,
      JSON.stringify({
        game: "riftbound",
        source_lineage: "owner",
        reference: `origins-target:${name}`,
        content: { card: inspected.content.card },
        evidence: {
          attestation: `Card-only admission from retained Riot structured record ${record.id}, proposal ${source.id}, and the Origins named Erratum. No Printing admitted. Retained source evidence: ${JSON.stringify(inspected.evidence)}`,
        },
        idempotency_key: `origins-card:${record.id}`,
      }),
    );
    const proposed = await cli(["entity-proposal", "create", "--proposal", proposalPath, "--yes"]);
    await writeFile(
      decisionPath,
      JSON.stringify({
        expected_generation: "0",
        idempotency_key: `admit-origins:${record.id}`,
        rationale:
          "Retained publisher Card evidence supports this Erratum target; Printing appearance remains unadmitted.",
      }),
    );
    const admitted = await cli([
      "entity-proposal",
      "admit",
      "--proposal-id",
      proposed.id,
      "--decision",
      decisionPath,
      "--yes",
    ]);
    admittedCards.set(name, admitted.history[0].decision.card.id);
  }
  let publication;
  if (resumePublicationId) {
    publication = await waitForAdministrationDocument(
      `/v1/publications/${resumePublicationId}`,
      (d) => d.state === "published",
      environment,
      worker,
    );
    const failed = await cli(["backup", "status", "--attempt-id", publication.backup_attempt_id]);
    if (failed.state !== "verified") {
      assert.equal(failed.state, "failed");
      const idempotency = "riftbound-signed-transport-backup-retry";
      await paceNativeRequest(environment);
      const statusResponse = await fetch(
        `${worker.url}/v1/status?${new URLSearchParams({ expected_current_revision_id: publication.resulting_revision_id })}`,
        { headers: { authorization: `Bearer ${key}` } },
      );
      assert.equal(statusResponse.status, 200);
      const status = await statusResponse.json();
      const binding = {
        production_target: status.resolved_target.production_target,
        expected_current_revision_id: publication.resulting_revision_id,
        idempotency_key: idempotency,
        failed_attempt_id: failed.idempotency_key,
        failed_attempt_digest: failed.attempt_digest,
      };
      await paceNativeRequest(environment);
      const existingRetry = await fetch(`${worker.url}/v1/backups/${idempotency}`, {
        headers: { authorization: `Bearer ${key}` },
      });
      assert.ok([200, 404].includes(existingRetry.status));
      if (existingRetry.status === 404) {
        const retry = await runCli(
          [
            "backup",
            "retry",
            "--expected-current-revision",
            publication.resulting_revision_id,
            "--idempotency-key",
            idempotency,
            "--failed-attempt-id",
            failed.idempotency_key,
            "--failed-attempt-digest",
            failed.attempt_digest,
            "--environment",
            "production",
            "--confirm",
            JSON.stringify(binding),
            "--yes",
            "--json",
          ],
          environment,
        );
        acceptedBackupRetry(retry, idempotency);
      } else {
        const existing = await existingRetry.json();
        const { production_target: _target, ...expectedResume } = binding;
        await resumeExistingBackupAttempt(existing, expectedResume, async (resume) => {
          await paceNativeRequest(environment);
          const resumed = await fetch(`${worker.url}${resume.path}`, {
            method: resume.method,
            headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
            body: JSON.stringify(resume.body),
          });
          assert.ok([200, 202].includes(resumed.status), await resumed.clone().text());
          return acceptedBackupRetry(
            { code: resumed.status === 202 ? 10 : 0, stdout: await resumed.text(), stderr: "" },
            idempotency,
          );
        });
      }
      const backup = await waitForAdministrationDocument(
        `/v1/backups/${idempotency}`,
        (d) => d.state === "verified" || (d.state === "failed" ? JSON.stringify(d) : false),
        environment,
        worker,
        { deadlineMs: 120_000 },
      );
      assert.equal(backup.catalogue_revision_id, publication.resulting_revision_id);
      assert.equal(backup.linked_attempt_id, failed.idempotency_key);
      t.diagnostic(`Verified supported backup retry for existing publication ${publication.id}`);
    } else {
      assert.equal(failed.catalogue_revision_id, publication.resulting_revision_id);
      assert.match(failed.manifest_sha256, /^[a-f0-9]{64}$/);
      t.diagnostic(`Reusing verified backup for published revision ${publication.resulting_revision_id}`);
    }
  } else {
    const prepared = await cli([
      "game-candidate",
      "prepare",
      "--run-id",
      run.id,
      "--game",
      "riftbound",
      "--expected-game-revision-id",
      "catrev_spine_000",
      "--idempotency-key",
      resumeDirectory ? "reviewed-riftbound-public-v5" : "reviewed-riftbound",
      "--yes",
    ]);
    const candidate = await waitForAdministrationDocument(
      `/v1/game-candidates/${prepared.id}`,
      (d) => d.state === "sealed" || (["failed", "paused"].includes(d.state) ? JSON.stringify(d) : false),
      environment,
      worker,
      { deadlineMs: 600_000 },
    );
    publication = await publishNativeCollection(
      { candidates: [candidate] },
      resumeDirectory ? "reviewed-riftbound-public-v5-publication" : "reviewed-riftbound-publication",
      environment,
      worker,
      120_000,
    );
  }
  const apiKey = crypto.randomUUID();
  api = await startWorker({ config: "apps/api/wrangler.jsonc", statePath, vars: { API_BEARER_KEY: apiKey } });
  await waitForHealth(`${api.url}/health`, apiKey, api);
  const exported = await nativeExportRecords(api.url, apiKey, publication.resulting_revision_id, "printings");
  assert.deepEqual(exported.map((p) => p.id).sort(), [...admittedPrintings.values()].sort());
  assert.ok(
    exported.every((p) => p.game_data.attributes.reverse_face === null && p.game_data.attributes.finish === null),
  );
  const errata = await nativeExportRecords(api.url, apiKey, publication.resulting_revision_id, "errata");
  assert.equal(errata.length, 31);
  assert.deepEqual(errata.map((e) => e.target_id).sort(), erratumTargets.map((n) => admittedCards.get(n)).sort());
  const products = await nativeExportRecords(api.url, apiKey, publication.resulting_revision_id, "products");
  assert.equal(products.length, 9);
  const releases = await nativeExportRecords(api.url, apiKey, publication.resulting_revision_id, "releases");
  assert.equal(releases.length, 9);
  assert.ok(releases.every((r) => r.region === "unknown"));
  assert.ok(releases.some((r) => r.date.precision === "quarter" && r.date.value === "2027-Q3"));
  const darkChild = errata.find((e) => e.target_id === admittedCards.get("Dark Child - Starter"));
  assert.equal(darkChild.corrected_value, "At the end of your turn, ready up to 2 runes.");
  const headers = { authorization: `Bearer ${apiKey}` };
  assert.equal((await fetch(`${api.url}/v1/printings/${exported[0].id}`)).status, 401);
  for (const [locator, id] of admittedPrintings) {
    const response = await fetch(`${api.url}/v1/printings/${id}`, { headers });
    assert.equal(response.status, 200);
    const data = (await response.json()).data;
    const record = exported.find((p) => p.id === id);
    for (const [field, value] of Object.entries(record)) assert.deepEqual(data[field], value, field);
    assert.equal(data.printing_images.length, 1);
    const image = data.printing_images[0];
    const content = await fetch(new URL(image.links.content, api.url), { headers });
    assert.equal(content.status, 200);
    const bytes = Buffer.from(await content.arrayBuffer());
    const capture = manifest.captures.find((c) => c.id === `riftbound-image-${locator}`);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), capture.sha256);
  }
  const printedMonk =
    "When you play me, buff two other friendly units. (Each one that doesn't have a buff gets a +1 [M] buff.)";
  const curate = async (entityType, entityId, path, value, previousValue, captureId) => {
    const capture = manifest.captures.find((c) => c.id === captureId);
    const proposal = {
      game: "riftbound",
      target: { kind: "field", entity_type: entityType, entity_id: entityId, path },
      assertion: { kind: "field", value },
      rationale: "Independent visual review of the retained Riot Printing image.",
      evidence: [{ kind: "owner_reference", uri: capture.url, content_digest: capture.sha256 }],
      effective_interval: { from: null, to: null },
      reviewed_source_digest: createHash("sha256").update(JSON.stringify(previousValue)).digest("hex"),
      supersedes_revision_id: null,
    };
    await writeFile(proposalPath, JSON.stringify(proposal));
    const call = async (args) => {
      const result = await runCli(["curated-revision", ...args, "--secrets-stdin-fd", "3", "--json"], environment, {
        secrets: { administration_key: key },
      });
      assert.equal(result.code, 0, result.stdout + result.stderr);
      return JSON.parse(result.stdout);
    };
    const validation = await call([
      "validate",
      "--proposal",
      proposalPath,
      "--expected-current-revision",
      publication.resulting_revision_id,
    ]);
    assert.equal(validation.valid, true);
    const idempotency = `review-image-${entityId}`;
    const query = new URLSearchParams({
      expected_current_revision_id: publication.resulting_revision_id,
      curated_operation: "create",
      curated_binding: JSON.stringify({
        affected_supported_game: "riftbound",
        target: proposal.target,
        content_digest: validation.proposal_digest,
        idempotency_key: idempotency,
      }),
    });
    await paceNativeRequest(environment);
    const status = await fetch(`${worker.url}/v1/status?${query}`, { headers: { authorization: `Bearer ${key}` } });
    assert.equal(status.status, 200);
    const confirmation = (await status.json()).resolved_target.confirmation;
    return call([
      "create",
      "--proposal",
      proposalPath,
      "--proposal-digest",
      validation.proposal_digest,
      "--expected-current-revision",
      publication.resulting_revision_id,
      "--idempotency-key",
      idempotency,
      "--environment",
      "production",
      "--confirm",
      confirmation,
      "--yes",
    ]);
  };
  await curate(
    "printing",
    admittedPrintings.get("ogn-141-298"),
    "/printed_rules_text",
    printedMonk,
    null,
    "riftbound-image-ogn-141-298",
  );
  await curate(
    "card",
    admittedCards.get("Ahri, Inquisitive"),
    "/game_data/attributes/tags",
    ["Ahri", "Ionia"],
    ["Ahri"],
    "riftbound-image-sfd-227-star-221",
  );
  const refresh = await cli([
    "game-candidate",
    "prepare",
    "--run-id",
    run.id,
    "--game",
    "riftbound",
    "--expected-game-revision-id",
    publication.resulting_revision_id,
    "--idempotency-key",
    "reviewed-image-facts",
    "--yes",
  ]);
  const refreshedCandidate = await waitForAdministrationDocument(
    `/v1/game-candidates/${refresh.id}`,
    (d) => d.state === "sealed" || (["failed", "paused"].includes(d.state) ? JSON.stringify(d) : false),
    environment,
    worker,
    { deadlineMs: 600_000 },
  );
  let finalPublication = await publishNativeCollection(
    { candidates: [refreshedCandidate] },
    "riftbound-image-facts",
    environment,
    worker,
    120_000,
  );
  const finalPrintings = await nativeExportRecords(
    api.url,
    apiKey,
    finalPublication.resulting_revision_id,
    "printings",
  );
  assert.deepEqual(finalPrintings.map((p) => p.id).sort(), [...admittedPrintings.values()].sort());
  assert.equal(
    finalPrintings.find((p) => p.id === admittedPrintings.get("ogn-141-298")).printed_rules_text,
    printedMonk,
  );
  let cards = await nativeExportRecords(api.url, apiKey, finalPublication.resulting_revision_id, "cards");
  assert.deepEqual(cards.find((c) => c.id === admittedCards.get("Ahri, Inquisitive")).game_data.attributes.tags, [
    "Ahri",
    "Ionia",
  ]);
  assert.match(cards.find((c) => c.id === admittedCards.get("Kinkou Monk")).effective_rules_text, /buff up to two/);
  // A new scoped source check exercises cross-run identity and evidence pins,
  // while the complete gallery's untouched Printings must remain available.
  const errataCapture = previous.captures.find((c) => c.id === "riftbound-errata");
  await writeFile(
    planPath,
    JSON.stringify({
      plans: [
        {
          supported_game: "riftbound",
          source_lineage: "riftbound-en",
          adapter_version: "riftbound-en@1",
          subset: "origins-errata",
          requests: [{ id: "riftbound-en:errata", url: errataCapture.url }],
        },
      ],
    }),
  );
  const fresh = await cli(["source", "collect", "--plan-file", planPath, "--idempotency-key", "fresh-origins-check"]);
  assert.notEqual(fresh.id, run.id);
  await cli(["source", "resume", "--run-id", fresh.id]);
  const freshCollection = await waitForAdministrationDocument(
    `/v1/ingestion-runs/${fresh.id}/game-candidates`,
    (d) =>
      d.candidates.some((c) => ["failed", "paused"].includes(c.state))
        ? JSON.stringify(d)
        : d.candidates.length === 1 && d.candidates[0].state === "sealed",
    environment,
    worker,
    { deadlineMs: 120_000 },
  );
  const freshCandidate = await cli(["game-candidate", "show", "--candidate-id", freshCollection.candidates[0].id]);
  finalPublication = await publishNativeCollection(
    { candidates: [freshCandidate] },
    "fresh-origins-publication",
    environment,
    worker,
    120_000,
  );
  const freshPrintings = await nativeExportRecords(
    api.url,
    apiKey,
    finalPublication.resulting_revision_id,
    "printings",
  );
  assert.deepEqual(freshPrintings, finalPrintings);
  const freshCards = await nativeExportRecords(api.url, apiKey, finalPublication.resulting_revision_id, "cards");
  assert.deepEqual(freshCards.map((c) => c.id).sort(), cards.map((c) => c.id).sort());
  cards = freshCards;
  const monkResponse = await fetch(`${api.url}/v1/cards/${admittedCards.get("Kinkou Monk")}`, { headers });
  assert.equal(monkResponse.status, 200);
  const monkCard = (await monkResponse.json()).data;
  assert.equal(monkCard.id, admittedCards.get("Kinkou Monk"));
  assert.match(monkCard.effective_rules_text, /buff up to two/);
  assert.ok(monkCard.printing_ids.includes(admittedPrintings.get("ogn-141-298")));
  const freshEvidence = await cli(["source", "show", "--run-id", fresh.id]);
  assert.deepEqual(freshEvidence.evidence_plans[0].coverage, {
    locale: "en",
    area: "errata",
    subset: "origins-errata",
  });
  assert.equal(freshEvidence.snapshots.length, 1);
  assert.equal(freshEvidence.snapshots[0].content.digest, errataCapture.sha256);
  assert.ok(!evidence.snapshots.some((s) => s.id === freshEvidence.snapshots[0].id));
  const restoredEvidence = await cli(["source", "show", "--run-id", run.id]);
  await stopWorker(api);
  await stopWorker(worker);
  const restoredState = await verifiedBackupApiState(statePath, directory);
  exportReader.clear();
  api = await startWorker({
    config: "apps/api/wrangler.jsonc",
    statePath: restoredState,
    vars: { API_BEARER_KEY: apiKey },
  });
  await waitForHealth(`${api.url}/health`, apiKey, api);
  assert.deepEqual(
    await nativeExportRecords(api.url, apiKey, finalPublication.resulting_revision_id, "printings"),
    finalPrintings,
  );
  assert.deepEqual(await nativeExportRecords(api.url, apiKey, finalPublication.resulting_revision_id, "cards"), cards);
  const restoredResponse = await fetch(`${api.url}/v1/printings/${admittedPrintings.get("ogn-141-298")}`, { headers });
  assert.equal(restoredResponse.status, 200);
  const restoredMonk = (await restoredResponse.json()).data;
  assert.equal(restoredMonk.printed_rules_text, printedMonk);
  const restoredImage = await fetch(new URL(restoredMonk.printing_images[0].links.content, api.url), { headers });
  assert.equal(restoredImage.status, 200);
  assert.equal(
    createHash("sha256")
      .update(Buffer.from(await restoredImage.arrayBuffer()))
      .digest("hex"),
    manifest.captures.find((c) => c.id === "riftbound-image-ogn-141-298").sha256,
  );
  restoredAdmin = await startWorker({
    ...checkpoint,
    config: configPath,
    statePath: restoredState,
    vars: { ...checkpoint.vars, ADMINISTRATION_KEY: key, SOURCE_HOST_PACING_MODE: "immediate" },
  });
  await waitForHealth(`${restoredAdmin.url}/health`, key, restoredAdmin);
  const monkCapture = manifest.captures.find((c) => c.id === "riftbound-image-ogn-141-298");
  await writeFile(
    proposalPath,
    JSON.stringify({
      game: "riftbound",
      target: {
        kind: "field",
        entity_type: "printing",
        entity_id: admittedPrintings.get("ogn-141-298"),
        path: "/printed_rules_text",
      },
      assertion: { kind: "field", value: printedMonk },
      rationale: "Verify restored private source authority beneath the published Curated Revision.",
      evidence: [{ kind: "owner_reference", uri: monkCapture.url, content_digest: monkCapture.sha256 }],
      effective_interval: { from: null, to: null },
      reviewed_source_digest: createHash("sha256").update("null").digest("hex"),
      supersedes_revision_id: null,
    }),
  );
  const restoredValidation = await runCli(
    [
      "curated-revision",
      "validate",
      "--proposal",
      proposalPath,
      "--expected-current-revision",
      finalPublication.resulting_revision_id,
      "--secrets-stdin-fd",
      "3",
      "--json",
    ],
    { ...environment, KEEPR_INGESTION_URL: restoredAdmin.url },
    { secrets: { administration_key: key } },
  );
  assert.equal(restoredValidation.code, 0, restoredValidation.stdout + restoredValidation.stderr);
  assert.equal(JSON.parse(restoredValidation.stdout).valid, true);
  const shownAfterRestore = await runCli(["source", "show", "--run-id", run.id, "--json"], {
    ...environment,
    KEEPR_INGESTION_URL: restoredAdmin.url,
  });
  assert.equal(shownAfterRestore.code, 0, shownAfterRestore.stdout + shownAfterRestore.stderr);
  const evidenceAfterRestore = JSON.parse(shownAfterRestore.stdout);
  assert.deepEqual(evidenceAfterRestore.snapshots, restoredEvidence.snapshots);
  assert.deepEqual(evidenceAfterRestore.observation_sets, restoredEvidence.observation_sets);
  const freshAfterRestore = await runCli(["source", "show", "--run-id", fresh.id, "--json"], {
    ...environment,
    KEEPR_INGESTION_URL: restoredAdmin.url,
  });
  assert.equal(freshAfterRestore.code, 0, freshAfterRestore.stdout + freshAfterRestore.stderr);
  assert.deepEqual(JSON.parse(freshAfterRestore.stdout).snapshots, freshEvidence.snapshots);
  assert.deepEqual(JSON.parse(freshAfterRestore.stdout).observation_sets, freshEvidence.observation_sets);
  t.diagnostic(
    JSON.stringify({
      replay_mode: resumePublicationId
        ? "resumed_published_revision"
        : resumeDirectory
          ? "resumed_retained_run"
          : "fresh_retained_collection",
      initial_collection_retained_snapshots: 14,
      journey_retained_snapshots: evidence.snapshots.length + freshEvidence.snapshots.length,
      journey_observations: [...evidence.observation_sets, ...freshEvidence.observation_sets].reduce(
        (n, set) => n + set.observation_count,
        0,
      ),
      observed_inventory_records: 1189,
      initial_collection_errata_observations: 31,
      observed_products: 9,
      visually_reviewed_printings: 6,
      additional_card_only_admissions: 30,
      injected_unretained_image_failures: 1183,
      elapsed_functional_replay_ms: Math.round(performance.now() - startedAt),
      unique_retained_body_bytes: [...captures.values()]
        .filter((c) => !c.id.startsWith("riftbound-sets"))
        .reduce((n, c) => n + c.bodyBytes.length, 0),
    }),
  );
  journeyCompleted = true;
});
