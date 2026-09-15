import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { expect, test } from "vitest";

const document = JSON.parse(readFileSync("contracts/admin-openapi.json", "utf8"));
const ajv = new Ajv2020({ strict: false, allErrors: true, inlineRefs: false });
addFormats(ajv);
ajv.addSchema(document, "administration");
const proposal = {
  game: "one-piece",
  target: { kind: "field", entity_type: "card", entity_id: "card_reviewed", path: "/name" },
  assertion: { kind: "field", value: "Reviewed name" },
  rationale: "Owner reviewed retained evidence.",
  evidence: [{ kind: "source_observation", id: `srcobs_${"a".repeat(180)}` }],
  effective_interval: { from: null, to: null },
  reviewed_source_digest: "a".repeat(64),
  supersedes_revision_id: null,
};
function request(path: string) {
  return ajv.compile({
    $ref: `administration#/paths/${path.replaceAll("/", "~1")}/post/requestBody/content/application~1json/schema`,
  });
}

test("generated Curated validation is strict while creation admits exact retained empty-name replay", () => {
  const validate = request("/v1/curated-revisions/validate");
  expect(validate({ proposal, catalogue_revision_id: "catrev_reviewed" }), JSON.stringify(validate.errors)).toBe(true);
  for (const change of [
    { game: ["one-piece"] },
    { game: "invented" },
    { effective_interval: null },
    { "": true, later: 1 },
    { assertion: { kind: "field" } },
  ])
    expect(validate({ proposal: { ...proposal, ...change }, catalogue_revision_id: "catrev_reviewed" })).toBe(false);
  const create = request("/v1/curated-revisions");
  const command = {
    proposal,
    proposal_digest: "b".repeat(64),
    environment: "production",
    expected_current_revision_id: "catrev_reviewed",
    idempotency_key: "owner key / long enough without opaque restriction",
  };
  expect(create(command), JSON.stringify(create.errors)).toBe(true);
  expect(create({ ...command, unexpected: true })).toBe(false);
  const retained = {
    ...command,
    "": true,
    later: [1, null],
    proposal: { ...proposal, "": "retained", later: { exact: true } },
  };
  expect(create(retained), JSON.stringify(create.errors)).toBe(true);
});

test("generated Curated lifecycle contracts require explicit nullable conflicts and full superseding proposals", () => {
  const command = {
    environment: "production",
    expected_current_revision_id: "catrev_reviewed",
    expected_event_version: 1,
    conflict_digest: null,
    rationale: "Owner decision.",
    idempotency_key: "decision key",
  };
  for (const operation of ["retire", "supersede"]) {
    const validate = request(`/v1/curated-revisions/{revision}/${operation}`);
    const body =
      operation === "retire"
        ? command
        : {
            ...command,
            proposal: { ...proposal, supersedes_revision_id: "currev_prior" },
            proposal_digest: "b".repeat(64),
          };
    expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
    const { conflict_digest: _conflict, ...missing } = body;
    expect(validate(missing)).toBe(false);
    expect(validate({ ...body, expected_event_version: "1" })).toBe(false);
  }
  const reaffirm = request("/v1/curated-revisions/{revision}/reaffirm");
  expect(reaffirm(command)).toBe(false);
  expect(reaffirm({ ...command, conflict_digest: "c".repeat(64) }), JSON.stringify(reaffirm.errors)).toBe(true);
});

test("generated Curated URI validation distinguishes fresh proposals from retained literal evidence", () => {
  const validate = request("/v1/curated-revisions/validate");
  const retained = ajv.compile({ $ref: "administration#/components/schemas/RetainedCuratedRevisionProposal" });
  for (const [uri, fresh] of [
    [" https://owner.example/review ", false],
    ["https://owner.example/\nreview", false],
    ["https:\\owner.example\\review", false],
    ["https://owner.example/é", false],
    ["relative/review", false],
    ["1https://owner.example/review", false],
    ["mailto:owner@example.com", true],
    ["urn:review:123", true],
    ["HTTPS://OWNER.EXAMPLE/review", true],
    ["https://owner.example/review%20note", true],
  ] as const) {
    const content = { ...proposal, evidence: [{ kind: "owner_reference", uri, content_digest: "a".repeat(64) }] };
    expect(validate({ proposal: content, catalogue_revision_id: "catrev_reviewed" }), uri).toBe(fresh);
    // The retained wire field is literal text; the retained decoder owns its
    // historical URL semantics without rewriting the acknowledged proposal.
    expect(retained(content), JSON.stringify(retained.errors)).toBe(true);
  }
});

test("generated Curated event details require the fields belonging to their lifecycle event", () => {
  const validate = ajv.compile({
    $ref: "administration#/components/schemas/CuratedRevisionInspection/properties/events/items",
  });
  const common = { id: "crevt_1", revision_id: "currev_1", event_version: 1, at: 1789430400000 };
  const binding = { expected_current_revision_id: "catrev_reviewed", rationale: "Reviewed decision." };
  const events: [string, Record<string, unknown>][] = [
    ["authored", { reviewed_source_digest: "a".repeat(64) }],
    [
      "source_change_detected",
      {
        conflict_id: "conflict_1",
        conflict_digest: "a".repeat(64),
        run_id: "run_1",
        previous_source_digest: "b".repeat(64),
        observed_source_digest: "c".repeat(64),
      },
    ],
    [
      "reaffirmed",
      {
        ...binding,
        conflict_id: "conflict_1",
        conflict_digest: "a".repeat(64),
        reviewed_source_digest: "c".repeat(64),
      },
    ],
    ["retired", { ...binding, conflict_id: null, conflict_digest: null }],
    ["superseded", { ...binding, superseded_by_revision_id: "currev_2", conflict_digest: null }],
  ];
  for (const [type, details] of events) {
    expect(validate({ ...common, type, details }), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...common, type, details: {} })).toBe(false);
    expect(validate({ ...common, type, details: { ...details, invented: true } })).toBe(false);
    for (const [otherType] of events.filter(([other]) => other !== type))
      expect(validate({ ...common, type: otherType, details })).toBe(false);
    if (type === "authored")
      expect(validate({ ...common, type, details: { ...details, supersedes_revision_id: "currev_prior" } })).toBe(true);
    if (type === "source_change_detected")
      expect(validate({ ...common, type, details: { ...details, preparation_id: "preparation_1" } })).toBe(true);
  }
});
