import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { readWorkerConfig } from "../cli/lib/config.mjs";
import {
  runCli,
  startWorker,
  stopWorker,
  waitForHealth,
  waitForAdministrationDocument,
} from "./helpers/acceptance-runtime.mjs";
import {
  inspectNativeCollection,
  nativeCheckpointTransport,
  publishNativeCollection,
} from "./helpers/native-catalogue-runtime.mjs";
import { isNativeCheckpointRequest } from "./helpers/native-checkpoint-hosts.mjs";

const pack = "acceptance/fixtures/real-sources/2026-09-15-pokemon-scope/raw";
const tcgdex = "https://api.tcgdex.net/v2/en";
// Unmodified retained Card records and scans. base4-126, swsh9-053 and
// swsh9-147 publish with their record image shared by their finish variants.
// Garchomp swsh9-109's image is unavailable and tk-ex-latia-8 has none, so their
// Printings stay proposals with explicit gaps; base1-5's edition variants have
// no depicted group; base3-62's galaxy foil claim and tk-ex-latia-2's omitted
// weakness value keep those records unresolved.
const selected = {
  base1: ["base1-5"],
  base3: ["base3-62"],
  base4: ["base4-126"],
  swsh9: ["swsh9-053", "swsh9-109", "swsh9-147"],
  "tk-ex-latia": ["tk-ex-latia-2", "tk-ex-latia-8"],
};
const scans = ["base3-62", "base4-126", "swsh9-053", "swsh9-147"];
const garchompImage = "https://assets.tcgdex.net/en/swsh/swsh9/109/high.png";
const cardFile = (id) =>
  id === "tk-ex-latia-2"
    ? "acceptance/fixtures/real-sources/2026-09-15-pokemon-optional-relations/raw/card-tk-ex-latia-2.body"
    : `${pack}/card-${id}.body`;

/** The inventory and Set envelopes are narrowed to the selected records; every
 * Card body and each Set's series and release date stay exactly as retained. */
async function publisher() {
  const responses = new Map();
  const summaries = [];
  for (const [id, cards] of Object.entries(selected)) {
    const detail = JSON.parse(await readFile(`${pack}/set-${id}.body`, "utf8"));
    const cardCount = { total: cards.length, official: cards.length };
    const members = detail.cards.filter((card) => cards.includes(card.id));
    assert.equal(members.length, cards.length);
    responses.set(`${tcgdex}/sets/${id}`, JSON.stringify({ ...detail, cardCount, cards: members }));
    summaries.push({ id, name: detail.name, cardCount });
    for (const card of cards) {
      const body = await readFile(cardFile(card));
      responses.set(`${tcgdex}/cards/${card}`, body);
      if (scans.includes(card))
        responses.set(`${JSON.parse(body).image}/high.png`, await readFile(`${pack}/image-${card}.body`));
    }
  }
  responses.set(`${tcgdex}/sets`, JSON.stringify(summaries));
  responses.set(`${tcgdex}/series/tcgp`, JSON.stringify({ id: "tcgp", name: "Pokémon TCG Pocket", sets: [] }));
  return responses;
}

test("the declared TCGdex catalogue publishes finish variants with their shared record image and keeps gaps explicit", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "keepr-pokemon-declared-"));
  const statePath = join(directory, "state");
  const responses = await publisher();
  const budgetPath = join(directory, "pokemon-declared-budget.json");
  await writeFile(
    budgetPath,
    JSON.stringify({
      max_dispatches: 40,
      max_source_bytes: 67108864,
      dispatch_deadline: new Date(Date.now() + 2 * 86400000).toISOString(),
    }),
  );
  const config = await readWorkerConfig("apps/ingestion/wrangler.jsonc");
  delete config.$schema;
  config.main = resolve("apps/ingestion/src/index.ts");
  config.d1_databases[0].migrations_dir = resolve("migrations");
  const configPath = join(directory, "ingestion.json");
  await writeFile(configPath, JSON.stringify(config));
  const checkpoint = await nativeCheckpointTransport(t, statePath, directory, configPath);
  const key = crypto.randomUUID();
  const fetched = [];
  const runtime = {
    ...checkpoint,
    config: configPath,
    statePath,
    vars: { ...checkpoint.vars, ADMINISTRATION_KEY: key, SOURCE_HOST_PACING_MODE: "immediate" },
    outboundService(request) {
      if (isNativeCheckpointRequest(request)) return checkpoint.outboundService(request);
      fetched.push(request.url);
      if (request.url === garchompImage) return new Response("missing", { status: 404 });
      const body = responses.get(request.url);
      assert.ok(body, `Unplanned source request ${request.url}`);
      const image = request.url.startsWith("https://assets.tcgdex.net/");
      return new Response(body, { headers: { "content-type": image ? "image/png" : "application/json" } });
    },
  };
  let ingestion,
    api,
    passed = false;
  t.after(async () => {
    if (api) await stopWorker(api);
    if (ingestion) await stopWorker(ingestion);
    if (passed) await rm(directory, { recursive: true, force: true });
    else t.diagnostic(`Retained Pokémon declared-catalogue state: ${directory}`);
  });
  ingestion = await startWorker({ ...runtime, migrate: true });
  await waitForHealth(`${ingestion.url}/health`, key, ingestion);
  const environment = { KEEPR_INGESTION_URL: ingestion.url, KEEPR_ADMINISTRATION_KEY: key };
  const cli = async (args) => {
    const result = await runCli([...args, "--json"], environment);
    assert.equal(result.code, 0, result.stdout + result.stderr + ingestion.getOutput());
    return JSON.parse(result.stdout);
  };
  const run = await cli([
    "source",
    "collect",
    "--plan-file",
    "docs/examples/pokemon-declared-catalogue-plan.json",
    "--budget-file",
    budgetPath,
    "--idempotency-key",
    "pokemon-declared",
  ]);
  await cli(["source", "resume", "--run-id", run.id]);
  const collection = await waitForAdministrationDocument(
    `/v1/ingestion-runs/${run.id}/game-candidates`,
    (d) =>
      d.candidates.some((c) => ["failed", "paused"].includes(c.state))
        ? JSON.stringify(d)
        : d.candidates.length === 1 && d.candidates[0].state === "sealed",
    environment,
    ingestion,
    { deadlineMs: 120000 },
  );
  // Two roots, five Sets, eight Cards and five record images, each fetched once.
  assert.equal(fetched.length, 20);
  assert.deepEqual(new Set(fetched), new Set([...responses.keys(), garchompImage]));
  const source = await cli(["source", "show", "--run-id", run.id]);
  assert.equal(source.acquisition.charged_dispatches, 20);
  assert.equal(source.acquisition.limiting_dimension, null);
  const inspection = await inspectNativeCollection(run.id, environment, {
    candidates: collection.candidates,
    partitionKinds: ["cards", "printings", "printing_images"],
  });
  assert.deepEqual(inspection.records.cards.map((card) => card.name).sort(), [
    "Clefairy",
    "Fire Energy",
    "Professor's Research",
  ]);
  assert.equal(inspection.records.printings.length, 5);
  // One retained object per record image, referenced by every finish variant.
  const images = inspection.records.printing_images;
  assert.equal(images.length, 5);
  assert.equal(new Set(images.map((image) => image.content_sha256)).size, 3);
  const proposals = (await cli(["entity-proposal", "list", "--game", "pokemon"])).proposals;
  assert.equal(proposals.filter((proposal) => proposal.status === "admitted").length, 5);
  assert.equal(proposals.filter((proposal) => proposal.status === "unresolved").length, 9);
  const publication = await publishNativeCollection(inspection, "pokemon-declared", environment, ingestion, 120000);
  assert.equal(publication.checkpoint.state, "verified");
  api = await startWorker({ config: "apps/api/wrangler.jsonc", statePath, vars: { API_BEARER_KEY: key } });
  await waitForHealth(`${api.url}/health`, key, api);
  const get = async (path) => {
    const response = await fetch(`${api.url}${path}`, { headers: { authorization: `Bearer ${key}` } });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const printings = (await get("/v1/printings?game=pokemon&limit=100")).data;
  assert.equal(printings.length, 5);
  const served = new Map();
  for (const printing of printings) {
    const [image] = (await get(`/v1/printings/${printing.id}`)).data.printing_images;
    assert.ok(image, `Printing ${printing.id} publishes its shared record image`);
    const response = await fetch(new URL(image.links.content, api.url), {
      headers: { authorization: `Bearer ${key}` },
    });
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    served.set(image.content_sha256, (served.get(image.content_sha256) ?? 0) + 1);
    assert.equal(bytes.length, image.content_byte_length);
  }
  assert.deepEqual([...served.values()].sort(), [1, 2, 2]);
  passed = true;
});
