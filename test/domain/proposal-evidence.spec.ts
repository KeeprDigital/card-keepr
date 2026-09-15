import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";
import { expect, test } from "vitest";
import {
  captureCompositionSnapshot,
  verifyCompositionSnapshot,
  type CompositionSnapshotEvidence,
} from "../../src/catalogue/backup-recovery/composition-verification";
import {
  type CompositionQuery,
  compositionVerificationQuery,
} from "../../src/catalogue/backup-recovery/composition-verification-repository";
import {
  captureProposalArtifacts,
  verifyProposalArtifacts,
} from "../../src/catalogue/backup-recovery/composition-proposal-artifacts";
import * as proposalEvidenceQueries from "./query-helpers/proposal-evidence";

// Frozen by the capture implementation at 07e51db, before the optional proposal receipt existed.
const historical = (name: string): CompositionSnapshotEvidence =>
  JSON.parse(readFileSync(new URL(`./fixtures/composition-snapshots/${name}.json`, import.meta.url), "utf8"));
function snapshotQuery(modern: boolean): CompositionQuery {
  const schema = ["source_archive_decodes", "source_parse_contexts", "source_parse_dependencies"].map((name) => ({
    name,
    type: "table",
    sql: `CREATE TABLE ${name}(id TEXT)`,
  }));
  return async (input) => {
    if (input.kind === "composition-state")
      return [
        {
          content_digest: "b".repeat(64),
          publication_operation_id: "publication_current",
          ingestion_run_id: "source",
          migration_level: modern ? 40 : 23,
          members: 1,
          cards: 1,
          products: 0,
          missing_search: 0,
          missing_lifecycle: 0,
          search_state: "ready",
        },
      ];
    if (input.kind === "composition-accepted-roots")
      return [
        {
          supported_game: "pokemon",
          candidate_id: "candidate",
          preparation_id: "preparation",
          manifest_digest: "d".repeat(64),
          root_digest: "e".repeat(64),
        },
      ];
    if (input.kind === "composition-schema") return modern ? schema.filter((row) => row.name > input.after) : [];
    if (input.kind === "composition-columns") return [{ name: "id" }];
    if (input.kind === "composition-source-artifacts")
      return input.after ? [] : [{ object_key: "archive", sha256: "a".repeat(64), byte_length: 3, kind: "raw" }];
    if (input.kind === "composition-parent-context-artifacts")
      return input.after ? [] : [{ object_key: "parent", sha256: "b".repeat(64), byte_length: 4, consistent: 1 }];
    if (input.kind === "composition-proposal-artifacts")
      return input.after
        ? []
        : [{ object_key: "proposal", sha256: "c".repeat(64), byte_length: 5, kind: "raw", consistent: 1 }];
    return [];
  };
}

test.each(["exact", "digest", "length", "kind", "missing"] as const)(
  "proposal closure compares all physical receipts across the 64-key page: %s",
  async (collision) => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(proposalEvidenceQueries.proposalEvidenceSchema);
      const insert = proposalEvidenceQueries.insertSourceSnapshot(database);
      const select = proposalEvidenceQueries.insertProposalSourceEvidence(database);
      for (let index = 0; index < 65; index++) {
        const id = `source-${index}`;
        insert.run(id, `raw/${String(index).padStart(3, "0")}`, "a".repeat(64), 1);
        select.run(id);
      }
      // The alias itself is unselected; every receipt for a selected physical key must still agree.
      if (collision === "kind")
        proposalEvidenceQueries.insertSourceObservationSet(database).run("alias", "raw/063", "a".repeat(64), 1);
      else
        insert.run("alias", "raw/063", (collision === "digest" ? "b" : "a").repeat(64), collision === "length" ? 2 : 1);
      proposalEvidenceQueries.insertProposal(database).run("proposal");
      const pin = proposalEvidenceQueries.insertEvidenceObjectReference(database);
      if (collision === "missing") pin.run("proposal", "entity_proposal", "raw/063-missing");
      const query: CompositionQuery = async (input) => {
        const request = compositionVerificationQuery(input);
        return database.prepare(request.sql).all(...(request.params as (string | number)[]));
      };
      if (collision !== "exact") {
        await expect(captureProposalArtifacts(query)).rejects.toThrow(
          "physical object receipts conflict or are missing",
        );
        return;
      }
      expect(await captureProposalArtifacts(query)).toMatchObject({ objects: 65, bytes: 65 });
      insert.run("parent", "raw/parent", "a".repeat(64), 1);
      insert.run("unreferenced-child", "raw/child", "a".repeat(64), 1);
      proposalEvidenceQueries
        .insertSourceObservationSet(database)
        .run("parent", "observations/parent", "b".repeat(64), 2);
      pin.run("proposal", "entity_proposal", "raw/parent");
      // The literal pin adds its owner's raw and observation sibling, without adopting another snapshot.
      expect(await captureProposalArtifacts(query)).toMatchObject({ objects: 67, bytes: 68 });
    } finally {
      database.close();
    }
  },
);

test.each([false, true])(
  "historical snapshot keeps its exact optional receipt set at modern schema=%s",
  async (modern) => {
    const expected = historical(modern ? "snapshot-schema40" : "snapshot-legacy");
    const query = snapshotQuery(modern);
    await expect(
      verifyCompositionSnapshot(async (input) => {
        expect(input.kind).not.toBe("composition-proposal-artifacts");
        return query(input);
      }, expected),
    ).resolves.toBeUndefined();
    const captured = await captureCompositionSnapshot(query, "current");
    const { proposal_evidence, ...original } = captured!;
    expect(original).toEqual(expected);
    if (modern)
      expect(proposal_evidence).toMatchObject({
        contract: "card-keepr-composition-proposal-evidence@1",
        objects: 1,
        bytes: 5,
      });
    else expect(proposal_evidence).toBeUndefined();
    await expect(verifyCompositionSnapshot(query, { ...expected, schema_sha256: "0".repeat(64) })).rejects.toThrow(
      "snapshot differs",
    );
  },
);

test("present proposal receipts are verified strictly and null never means historical absence", async () => {
  const query = snapshotQuery(true);
  const captured = (await captureCompositionSnapshot(query, "current"))!;
  await expect(verifyCompositionSnapshot(query, captured)).resolves.toBeUndefined();
  for (const receipt of [
    null,
    { ...captured.proposal_evidence, contract: "unknown" },
    { ...captured.proposal_evidence, objects: -1 },
    { ...captured.proposal_evidence, bytes: 1.5 },
    { ...captured.proposal_evidence, sha256: "invalid" },
  ]) {
    await expect(
      verifyCompositionSnapshot(query, { ...captured, proposal_evidence: receipt } as CompositionSnapshotEvidence),
    ).rejects.toThrow();
    await expect(
      verifyProposalArtifacts(query, undefined, receipt as CompositionSnapshotEvidence["proposal_evidence"]),
    ).rejects.toThrow("receipt is invalid");
  }
  const emptyQuery: CompositionQuery = async () => [];
  await expect(
    verifyProposalArtifacts(emptyQuery, undefined, {
      contract: "card-keepr-composition-proposal-evidence@1",
      objects: 0,
      bytes: 0,
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    }),
  ).resolves.toBeUndefined();
  await expect(verifyProposalArtifacts(query, undefined, captured.proposal_evidence)).rejects.toThrow(
    "Source evidence storage is required",
  );
});
