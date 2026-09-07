import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { verifiedBackupApiState } from "./helpers/verified-backup-api-state.mjs";
import {
  applyMigrations,
  runCli,
  startWorker,
  stopWorker,
  waitForHealth,
  waitForAdministrationDocument,
} from "./helpers/acceptance-runtime.mjs";
import {
  nativeCheckpointTransport,
  publishNativeCollection,
  nativeExportRecords,
} from "./helpers/native-catalogue-runtime.mjs";

// Actual retained HTTP bodies. External HTTP and Cloudflare control plane are
// replayed locally; collection, parsing and all owner operations are shipped code.
test("retained Riot catalogue: owner reviews, publishes and restores English inventory, Errata and Products", async (t) => {
  const startedAt = performance.now();
  const directory = await mkdtemp(join(tmpdir(), "keepr-real-riftbound-"));
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
  await applyMigrations(statePath);
  const checkpoint = await nativeCheckpointTransport(t, statePath, directory, configPath);
  const key = crypto.randomUUID();
  const served = [];
  const worker = await startWorker({
    ...checkpoint,
    config: configPath,
    statePath,
    vars: { ...checkpoint.vars, ADMINISTRATION_KEY: key, SOURCE_HOST_PACING_MODE: "immediate" },
    outboundService: async (request) => {
      if (new URL(request.url).hostname === "api.cloudflare.com") return checkpoint.outboundService(request);
      const capture = captures.get(request.url);
      if (!capture) {
        assert.equal(new URL(request.url).hostname, "cmsassets.rgpub.io", `undeclared request ${request.url}`);
        // Injected unavailable image, not an observed Riot outage or a retained image.
        return new Response("Image not retained in this deterministic replay", { status: 404 });
      }
      served.push(capture.id);
      return new Response(capture.bodyBytes, { headers: { "content-type": capture.contentType } });
    },
  });
  let api, restoredAdmin;
  t.after(async () => {
    if (api) await stopWorker(api);
    if (restoredAdmin) await stopWorker(restoredAdmin);
    await stopWorker(worker);
    await rm(directory, { recursive: true, force: true });
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
  const planPath = join(directory, "plan.json");
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
  const run = JSON.parse(collected.stdout);
  const resumed = await runCli(["source", "resume", "--run-id", run.id, "--json"], environment);
  assert.equal(resumed.code, 0, resumed.stderr);
  await waitForAdministrationDocument(
    `/v1/ingestion-runs/${run.id}/evidence`,
    (d) => d.state === "parsing" || (d.state === "failed" ? JSON.stringify(d) : false),
    environment,
    worker,
    { deadlineMs: 600_000 },
  );
  await waitForAdministrationDocument(
    `/v1/ingestion-runs/${run.id}/game-candidates`,
    (d) => d.candidates.length > 0 && d.candidates.every((c) => ["sealed", "failed"].includes(c.state)),
    environment,
    worker,
    { deadlineMs: 600_000 },
  );
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
  let after = null;
  do {
    const result = await runCli(
      ["entity-proposal", "list", "--game", "riftbound", ...(after ? ["--after", after] : []), "--json"],
      environment,
    );
    assert.equal(result.code, 0, result.stdout);
    const page = JSON.parse(result.stdout);
    proposals.push(...page.proposals);
    after = page.next_cursor;
  } while (after);
  assert.equal(proposals.length, 1189);
  assert.equal(new Set(proposals.map((p) => p.id)).size, 1189);
  assert.deepEqual(
    [...new Set(served)].sort(),
    [
      ...current.captures.filter((c) => c.id.startsWith("riftbound-cards-")).map((c) => c.id),
      ...previous.captures.filter((c) => c.id.startsWith("riftbound-image-")).map((c) => c.id),
      "riftbound-errata",
      "riftbound-products",
    ].sort(),
  );
  const intake = await cli(["game-candidate", "list", "--run-id", run.id]);
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
    const admitted = await cli([
      "entity-proposal",
      "admit",
      "--proposal-id",
      proposal.id,
      "--decision",
      decisionPath,
      "--yes",
    ]);
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
    "reviewed-riftbound",
    "--yes",
  ]);
  const candidate = await waitForAdministrationDocument(
    `/v1/game-candidates/${prepared.id}`,
    (d) => d.state === "sealed" || (d.state === "failed" ? JSON.stringify(d) : false),
    environment,
    worker,
    { deadlineMs: 600_000 },
  );
  const publication = await publishNativeCollection(
    { candidates: [candidate] },
    "reviewed-riftbound-publication",
    environment,
    worker,
    120_000,
  );
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
    const content = await fetch(image.links.content, { headers });
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
    (d) => d.state === "sealed" || (d.state === "failed" ? JSON.stringify(d) : false),
    environment,
    worker,
    { deadlineMs: 600_000 },
  );
  const finalPublication = await publishNativeCollection(
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
  const cards = await nativeExportRecords(api.url, apiKey, finalPublication.resulting_revision_id, "cards");
  assert.deepEqual(cards.find((c) => c.id === admittedCards.get("Ahri, Inquisitive")).game_data.attributes.tags, [
    "Ahri",
    "Ionia",
  ]);
  assert.match(cards.find((c) => c.id === admittedCards.get("Kinkou Monk")).effective_rules_text, /buff up to two/);
  const restoredEvidence = await cli(["source", "show", "--run-id", run.id]);
  await stopWorker(api);
  await stopWorker(worker);
  const restoredState = await verifiedBackupApiState(statePath, directory);
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
  const restoredImage = await fetch(restoredMonk.printing_images[0].links.content, { headers });
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
  const shownAfterRestore = await runCli(["source", "show", "--run-id", run.id, "--json"], {
    ...environment,
    KEEPR_INGESTION_URL: restoredAdmin.url,
  });
  assert.equal(shownAfterRestore.code, 0, shownAfterRestore.stdout + shownAfterRestore.stderr);
  const evidenceAfterRestore = JSON.parse(shownAfterRestore.stdout);
  assert.deepEqual(evidenceAfterRestore.snapshots, restoredEvidence.snapshots);
  assert.deepEqual(evidenceAfterRestore.observation_sets, restoredEvidence.observation_sets);
  t.diagnostic(
    JSON.stringify({
      retained_snapshots: 14,
      observed_inventory_records: 1189,
      observed_errata: 31,
      observed_products: 9,
      visually_reviewed_printings: 6,
      additional_card_only_admissions: 30,
      injected_unretained_image_failures: 1183,
      elapsed_functional_replay_ms: Math.round(performance.now() - startedAt),
      retained_body_bytes: [...captures.values()]
        .filter((c) => !c.id.startsWith("riftbound-sets"))
        .reduce((n, c) => n + c.bodyBytes.length, 0),
    }),
  );
});
