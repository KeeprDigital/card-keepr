import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import manifestSchemaV1 from "../prototype/formalize-implementation-contracts/schemas/catalogue-export-manifest.schema.json";
import manifestSchemaV2 from "../prototype/formalize-implementation-contracts/schemas/catalogue-export-manifest-v2.schema.json";
import recordSchemaV1 from "../prototype/formalize-implementation-contracts/schemas/catalogue-export-record.schema.json";
import recordSchemaV2 from "../prototype/formalize-implementation-contracts/schemas/catalogue-export-record-v2.schema.json";
import { buildCatalogueExport } from "../src/catalogue/export";
import { fixtureCandidate, type FixtureCandidate } from "../src/catalogue/fixture";
import {
  legalityRuleExportRecords,
  legalityRuleRelationshipRecords,
} from "../src/catalogue/legality-export";
import {
  legalityRulesForCandidate,
  parseRetainedLegalityRules,
  resolveLegalityRuleCards,
  type LegalityRule,
  type RetainedLegalityRule,
} from "../src/catalogue/legality-rule";
import { contextualLegalityStatusResponse } from "../src/catalogue/legality-status";
import { retainedReconciliationObservation } from "../src/catalogue/reconciliation-evidence";
import { requiredSourceAdapter } from "../src/catalogue/source-adapters";

describe("Catalogue Export schema v2 resolution", () => {
  test("every emitted component URI resolves and validates every record", async () => {
    const { candidate, digest } = await fixtureCandidate(
      "first-catalogue",
      ["one-piece"],
    );
    const built = await buildCatalogueExport(
      candidate,
      digest,
      "catrev_contract_v2",
      "2026-07-31T00:00:00.000Z",
    );
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    for (const schema of [
      recordSchemaV1,
      recordSchemaV2,
      manifestSchemaV1,
      manifestSchemaV2,
    ]) {
      ajv.addSchema(schema);
    }

    for (const [index, component] of built.manifest.components.entries()) {
      const validate = ajv.getSchema(component.record_schema);
      assert.equal(
        typeof validate,
        "function",
        `${component.name} advertises an unresolved record_schema`,
      );
      const records = gunzipSync(built.objects[index]!.bytes)
        .toString("utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown);
      for (const record of records) {
        assert.equal(
          validate!(record),
          true,
          `${component.name}: ${ajv.errorsText(validate!.errors)}`,
        );
      }
    }
  });
});

describe("official adapter-owned completeness", () => {
  const adapters = [
    ["one-piece-json-document@3", "EN-OCEANIA"],
    ["fusion-world-en@2", "EN-OCEANIA"],
    ["digimon-en@2", "EN-OCEANIA"],
    ["gundam-en-asia@2", "EN-ASIA"],
    ["gundam-en-us@2", "EN-US"],
  ] as const;

  for (const [adapterVersion, partition] of adapters) {
    test(`${adapterVersion} accepts an explicitly complete empty legality partition`, () => {
      const observations = requiredSourceAdapter(adapterVersion).parse(
        officialSurfaceDocument(partition, [], 0),
      );
      expect(observations).toEqual([
        expect.objectContaining({ observation_type: "legality_rules" }),
      ]);
    });

    test(`${adapterVersion} fails closed when its legality surface is missing`, () => {
      const document = officialSurfaceDocument(partition, [], 0);
      delete document.surfaces.legality_rules;
      expect(() =>
        requiredSourceAdapter(adapterVersion).parse(document),
      ).toThrow(/required Legality Rule surface/i);
    });

    test(`${adapterVersion} rejects a false-empty legality partition`, () => {
      expect(() =>
        requiredSourceAdapter(adapterVersion).parse(
          officialSurfaceDocument(partition, [], 1),
        ),
      ).toThrow(/declared.*parsed|record count/i);
    });
  }
});

describe("canonical immutable Legality Rule identity", () => {
  test("the canonical ID includes lineage identity and retains the official ID", async () => {
    const retained = parseRetainedLegalityRules(
      {
        legality_rules: [
          officialRule({
            id: "official-42",
            card_numbers: ["GD30-001"],
          }),
        ],
      },
      provenance("gundam-en-asia"),
    );
    const resolved = await resolveLegalityRuleCards(retained, [
      contractCard("card_gd30_001", "GD30-001", "1"),
    ]);
    const digest = createHash("sha256")
      .update(
        '{"official_id":"official-42","source_lineage":"gundam-en-asia"}',
      )
      .digest("hex");

    expect(resolved[0]).toMatchObject({
      id: `legality_rule_${digest}`,
      official_id: "official-42",
      source_lineage: "gundam-en-asia",
    });
  });

  test("re-observing one canonical ID with changed semantics blocks before approval", () => {
    const priorRule = resolvedRule({
      id: "legality_rule_immutable",
      official_wording: "GD30-001 is eligible.",
      effect: { type: "eligible" },
      first_revision_id: "catrev_first",
      last_observed_revision_id: "catrev_first",
    });
    const changedRule = resolvedRule({
      id: "legality_rule_immutable",
      official_wording: "GD30-001 is banned.",
      effect: { type: "ban" },
    });
    const prior = contractCandidate([priorRule]);

    expect(() =>
      legalityRulesForCandidate(
        prior,
        "gundam-en-asia",
        [changedRule],
      ),
    ).toThrow(/official identity.*changed semantics|new official identity/i);
  });

  test("unchanged re-observation preserves canonical identity and first revision", () => {
    const priorRule = resolvedRule({
      id: "legality_rule_immutable",
      first_revision_id: "catrev_first",
      last_observed_revision_id: "catrev_first",
    });
    const incoming = resolvedRule({ id: "legality_rule_immutable" });
    const [reobserved] = legalityRulesForCandidate(
      contractCandidate([priorRule]),
      "gundam-en-asia",
      [incoming],
    );

    expect(reobserved).toMatchObject({
      id: "legality_rule_immutable",
      first_revision_id: "catrev_first",
    });
  });
});

describe("bounded retained-evidence reconciliation", () => {
  test("observation objects are read sequentially instead of retained concurrently", async () => {
    const fixture = await retainedEvidenceFixture(6);
    let activeReads = 0;
    let maximumConcurrentReads = 0;
    const bucket = {
      async get(key: string) {
        const bytes = fixture.objects.get(key)!;
        return {
          size: bytes.byteLength,
          async arrayBuffer() {
            activeReads += 1;
            maximumConcurrentReads = Math.max(
              maximumConcurrentReads,
              activeReads,
            );
            await new Promise((resolve) => setTimeout(resolve, 5));
            activeReads -= 1;
            return bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            );
          },
        };
      },
    };

    await retainedReconciliationObservation(
      fixture.database as D1Database,
      bucket as unknown as R2Bucket,
      "ingest_bounded",
    );
    expect(maximumConcurrentReads).toBe(1);
  });

  test("aggregate retained bytes fail before reads can exceed the reconciliation budget", async () => {
    const fixture = retainedEvidenceRows(33, 1024 * 1024);
    const bucket = {
      async get() {
        throw new Error("aggregate budget was checked too late");
      },
    };
    await expect(
      retainedReconciliationObservation(
        fakeEvidenceDatabase(
          fixture.requests,
          fixture.observations,
        ) as D1Database,
        bucket as unknown as R2Bucket,
        "ingest_over_budget",
      ),
    ).rejects.toThrow(/aggregate reconciliation byte budget/i);
  });
});

describe("Legality Rule relationship lifecycle", () => {
  test("a disappeared and reappeared relationship preserves first and last-missing revisions", async () => {
    const rule = {
      ...resolvedRule({
        id: "legality_rule_reappeared",
        card_ids: ["card_gd30_001"],
        first_revision_id: "catrev_first",
        last_observed_revision_id: "catrev_third",
      }),
      current: true,
      last_missing_revision_id: "catrev_second",
    };
    const [relationship] = await legalityRuleRelationshipRecords(
      contractCandidate([rule as LegalityRule]),
      "catrev_third",
    );

    expect(relationship.lifecycle).toEqual({
      first_revision_id: "catrev_first",
      last_observed_revision_id: "catrev_third",
      current: true,
      last_missing_revision_id: "catrev_second",
    });
  });

  test("rule disappearance removes API applicability and reappearance restores it", async () => {
    const card = contractCard("card_gd30_001", "GD30-001", "1");
    const first = resolvedRule({
      id: "legality_rule_reappeared",
      card_ids: [card.id],
      first_revision_id: "catrev_first",
      last_observed_revision_id: "catrev_first",
      current: true,
      last_missing_revision_id: null,
    });
    const [missing] = legalityRulesForCandidate(
      contractCandidate([first]),
      "gundam-en-asia",
      [],
    );
    expect(missing).toMatchObject({
      current: false,
      first_revision_id: "catrev_first",
      last_observed_revision_id: "catrev_first",
    });
    const missingResponse = await contextualLegalityStatusResponse(
      legalityRequest(card.id),
      fakeLegalityDatabase(card, [missing!]) as D1Database,
    );
    const missingDocument = (await missingResponse.json()) as {
      data: { status: string; rule_ids: string[] }[];
    };
    expect(missingDocument.data[0]).toMatchObject({
      status: "indeterminate",
      rule_ids: [],
    });

    const [reappeared] = legalityRulesForCandidate(
      contractCandidate([
        {
          ...missing!,
          last_missing_revision_id: "catrev_second",
        },
      ]),
      "gundam-en-asia",
      [
        resolvedRule({
          id: first.id,
          card_ids: [card.id],
        }),
      ],
    );
    const response = await contextualLegalityStatusResponse(
      legalityRequest(card.id),
      fakeLegalityDatabase(card, [reappeared!]) as D1Database,
    );
    const document = (await response.json()) as {
      data: { status: string; rule_ids: string[] }[];
    };
    expect(document.data[0]).toMatchObject({
      status: "legal",
      rule_ids: [first.id],
    });
    const [relationship] = await legalityRuleRelationshipRecords(
      contractCandidate([
        {
          ...reappeared!,
          last_observed_revision_id: "catrev_third",
        },
      ]),
      "catrev_third",
    );
    expect(relationship.lifecycle).toMatchObject({
      first_revision_id: "catrev_first",
      last_observed_revision_id: "catrev_third",
      current: true,
      last_missing_revision_id: "catrev_second",
    });
  });
});

describe("schema and runtime parity", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(recordSchemaV1);
  ajv.addSchema(recordSchemaV2);
  const validate = ajv.getSchema(
    `${recordSchemaV2.$id}#/$defs/LegalityRuleRecord`,
  )!;

  test("copy_limit zero is rejected by both adapter runtime and schema v2", () => {
    expect(() =>
      parseRetainedLegalityRules(
        {
          legality_rules: [
            officialRule({
              effect: { type: "copy_limit", maximum_copies: 0 },
            }),
          ],
        },
        provenance("gundam-en-asia"),
      ),
    ).toThrow(/positive integer/i);
    expect(
      validate(
        exportedRule({
          effect: { type: "copy_limit", maximum_copies: 0 },
          kind: "restricted",
        }),
      ),
    ).toBe(false);
  });

  test("unknown Legality regions are rejected by runtime and schema v2", () => {
    expect(() =>
      parseRetainedLegalityRules(
        {
          legality_rules: [
            officialRule({ region: "unknown" }),
          ],
        },
        provenance("gundam-en-asia"),
      ),
    ).toThrow(/region is unsupported/i);
    expect(validate(exportedRule({ region: "unknown" }))).toBe(false);
  });
});

describe("indeterminate nullable rotation and canonical set operands", () => {
  test("a nullable canonical block_icon makes rotation indeterminate", async () => {
    const card = contractCard("card_nullable_block", "GD30-009", null);
    const rule = resolvedRule({
      id: "legality_rule_nullable_rotation",
      card_ids: [card.id],
      effect: { type: "rotation", eligible_blocks: ["1"] },
    });
    const response = await contextualLegalityStatusResponse(
      new Request(
        `https://card-keepr.invalid/v1/legality-status?card_id=${card.id}&on=2026-07-31&format=standard&region=EN-ASIA`,
      ),
      fakeLegalityDatabase(card, [rule]) as D1Database,
    );
    const document = (await response.json()) as {
      data: { status: string }[];
    };
    expect(document.data[0]!.status).toBe("indeterminate");
  });

  test("raw prohibited-combination export deduplicates and UTF-8 set-sorts with_card_ids", () => {
    const rule = resolvedRule({
      id: "legality_rule_combination",
      effect: {
        type: "prohibited_combination",
        with_card_ids: ["card_a", "card:A", "card-a", "card_a"],
      },
    });
    const [record] = legalityRuleExportRecords(contractCandidate([rule]));
    expect(record.effect).toEqual({
      type: "prohibited_combination",
      with_card_ids: ["card-a", "card:A", "card_a"],
    });
  });
});

function officialSurfaceDocument(
  partition: string,
  legalityRules: unknown[],
  declaredLegalityRecords: number,
) {
  return {
    surfaces: {
      cards: {
        partition,
        declared_record_count: 0,
        pages: [
          {
            number: 1,
            total_pages: 1,
            declared_record_count: 0,
            records: [],
          },
        ],
      },
      legality_rules: {
        partition,
        pages:
          declaredLegalityRecords === 0
            ? []
            : [
                {
                  number: 1,
                  total_pages: 1,
                  declared_record_count: declaredLegalityRecords,
                  records: legalityRules,
                },
              ],
        declared_record_count: declaredLegalityRecords,
      },
    },
  };
}

function provenance(sourceLineage: string) {
  return {
    game: "gundam" as const,
    sourceLineage,
    sourceSnapshotId: "snapshot_contract",
    sourceObservationSetId: "srcobsset_contract",
    sourceObservationId: "srcobs_contract",
  };
}

function officialRule(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "official-rule",
    game: "gundam",
    region: "EN-ASIA",
    format: "standard",
    event_tier: null,
    effective_from: "2026-01-01",
    effective_until: null,
    card_numbers: [],
    official_wording: "Official eligibility assertion.",
    effect: { type: "eligible" },
    representable: true,
    ...overrides,
  };
}

function contractCard(
  id: string,
  number: string,
  blockIcon: string | null,
) {
  return {
    id,
    game: "gundam" as const,
    official_identity: { kind: "card_number" as const, value: number },
    name: number,
    effective_rules_text: "Rules",
    game_data: {
      profile: "gundam@1" as const,
      attributes: {
        card_type: "unit",
        colours: ["blue"],
        level: 1,
        cost: 1,
        block_icon: blockIcon,
        effect_text: "",
        zone: "space",
        traits: [],
        link_condition: null,
        ap: 1,
        hp: 1,
        series_titles: [],
      },
    },
  };
}

function resolvedRule(
  overrides: Partial<LegalityRule> = {},
): LegalityRule {
  return {
    id: "legality_rule_contract",
    official_id: "official-rule",
    game: "gundam",
    region: "EN-ASIA",
    format: "standard",
    event_tier: null,
    effective_from: "2026-01-01",
    effective_until: null,
    card_ids: [],
    official_wording: "Official eligibility assertion.",
    effect: { type: "eligible" },
    source_lineage: "gundam-en-asia",
    source_snapshot_id: "snapshot_contract",
    source_observation_set_id: "srcobsset_contract",
    source_observation_id: "srcobs_contract",
    ...overrides,
  } as LegalityRule;
}

function contractCandidate(
  rules: readonly LegalityRule[],
): FixtureCandidate {
  return {
    fixture: "first-catalogue",
    selected_games: ["gundam"],
    cards: [],
    printings: [],
    legality_rules: rules,
  };
}

function exportedRule(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "legality_rule",
    id: "legality_rule_contract",
    official_id: "official-rule",
    game: "gundam",
    region: "EN-ASIA",
    format: "standard",
    event_tier: null,
    effective_from: "2026-01-01",
    effective_until: null,
    kind: "eligible",
    effect: { type: "eligible" },
    card_ids: [],
    official_wording: "Official eligibility assertion.",
    ...overrides,
  };
}

function fakeLegalityDatabase(
  card: ReturnType<typeof contractCard>,
  rules: readonly LegalityRule[],
) {
  let query = 0;
  return {
    prepare() {
      query += 1;
      const current = query;
      return {
        bind() {
          return {
            async first() {
              if (current !== 1) return null;
              return {
                current_revision_id: "catrev_contract",
                published_at: "2026-07-31T00:00:00.000Z",
                document_json: JSON.stringify(card),
              };
            },
            async all() {
              return {
                results: rules.map((rule) => ({
                  document_json: JSON.stringify(rule),
                })),
              };
            },
          };
        },
      };
    },
  };
}

function legalityRequest(cardId: string): Request {
  return new Request(
    `https://card-keepr.invalid/v1/legality-status?card_id=${cardId}&on=2026-07-31&format=standard&region=EN-ASIA`,
  );
}

async function retainedEvidenceFixture(count: number) {
  const rows = retainedEvidenceRows(count, 0);
  const objects = new Map<string, Uint8Array>();
  for (const row of rows.observations) {
    const document = {
      contract: "card-keepr-source-observations@1",
      id: row.observation_set_id,
      source_snapshot_id: row.source_snapshot_id,
      source_lineage: row.source_lineage,
      supported_game: row.supported_game,
      game_profile_version: row.game_profile_version,
      adapter_version: row.adapter_version,
      coverage_proof: {
        kind: "synthetic_fixture",
        adapter_version: row.adapter_version,
        parser_contract: "synthetic-fixture-card-document@1",
      },
      evidence_summary: {
        structurally_complete: true,
        required_surfaces_complete: true,
        partitions_complete: true,
        observation_count: 1,
        declared_record_count: 1,
        parsed_record_count: 1,
      },
      observations: [
        {
          id: `srcobs_${row.request_id}`,
          ordinal: 1,
          value: {
            observation_type: "legality_rules",
            legality_rules: [],
            completeness: {
              structurally_complete: true,
              required_surfaces_complete: true,
              partitions_complete: true,
              declared_record_count: 1,
              parsed_record_count: 1,
            },
          },
        },
      ],
    };
    const bytes = new TextEncoder().encode(JSON.stringify(document));
    row.content_byte_length = bytes.byteLength;
    row.content_digest = createHash("sha256")
      .update(bytes)
      .digest("hex");
    objects.set(row.content_object_key, bytes);
  }
  return {
    database: fakeEvidenceDatabase(rows.requests, rows.observations),
    objects,
  };
}

function retainedEvidenceRows(count: number, bytes: number) {
  const requests = Array.from({ length: count }, (_, index) => ({
    request_id: `request_${index}`,
    sequence_number: index + 1,
    state: "observed",
    source_snapshot_id: `snapshot_${index}`,
  }));
  const observations = requests.map((request, index) => ({
    request_id: request.request_id,
    observation_set_id: `srcobsset_${index}`,
    source_snapshot_id: request.source_snapshot_id!,
    source_lineage: "gundam-en-asia",
    supported_game: "gundam",
    game_profile_version: "gundam@1",
    adapter_version: "fixture-gundam-en-asia-json@1",
    content_digest: "0".repeat(64),
    content_byte_length: bytes,
    content_object_key: `observations/${index}.json`,
    observation_count: 1,
    plan_source_lineage: "gundam-en-asia",
    plan_supported_game: "gundam",
    plan_game_profile_version: "gundam@1",
    plan_adapter_version: "fixture-gundam-en-asia-json@1",
    plan_origin: "synthetic_fixture",
  }));
  return { requests, observations };
}

function fakeEvidenceDatabase(
  requests: readonly unknown[],
  observations: readonly unknown[],
) {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return {
            async all() {
              return {
                results: sql.includes("FROM source_requests")
                  ? requests
                  : observations,
              };
            },
          };
        },
      };
    },
  };
}
