import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "vitest";
import { catalogueStore } from "../../src/catalogue/shared/catalogue-store-repository.ts";
import { assertClosedRequestGraph } from "../../src/catalogue/reconciliation/reconciliation-source-graph.ts";
import { prepareSourceDocuments } from "../../src/catalogue/reconciliation/reconciliation-source-document.ts";
import { reconciliationCheckpoint } from "../../src/catalogue/reconciliation/reconciliation-checkpoint.ts";
import { ReconciliationContinuation } from "../../src/catalogue/reconciliation/reconciliation-continuation.ts";
import { d1Adapter } from "../../acceptance/helpers/query-helpers/sqlite-d1-adapter.mjs";
import { createSourceDocumentCheckpointTable } from "./query-helpers/source-document-gaps.mjs";

test("source document traversal checkpoints long unavailable-image gaps and their terminal cursor", async () => {
  const db = new DatabaseSync(":memory:");
  createSourceDocumentCheckpointTable(db);
  const store = catalogueStore(d1Adapter(db));
  const visited = [];
  let iterations = 0;
  try {
    for (;;) {
      let calls = 0;
      async function* evidenceAfter(after) {
        for (let sequence = (after?.sequenceNumber ?? -1) + 1; sequence < 1190; sequence++) {
          assert.ok(++calls <= 16, "unavailable selections must yield within the callback budget");
          visited.push(sequence);
          yield { request: { sequence_number: sequence, request_id: `image-${sequence}` }, row: null };
        }
      }
      try {
        await prepareSourceDocuments(store, {}, "preparation", "digest", evidenceAfter, () => assert.fail(), true);
        break;
      } catch (error) {
        if (!(error instanceof ReconciliationContinuation)) throw error;
        assert.ok(++iterations < 100);
      }
    }
    assert.deepEqual(
      visited,
      Array.from({ length: 1190 }, (_, i) => i),
    );
    const final = await reconciliationCheckpoint(store, "preparation", "source_documents");
    assert.equal(final.value.sequenceNumber, 1189);
    assert.equal(final.value.complete, true);
  } finally {
    db.close();
  }
});

test("source document work starts in a fresh callback after a partial unavailable-image gap", async () => {
  const db = new DatabaseSync(":memory:");
  createSourceDocumentCheckpointTable(db);
  const store = catalogueStore(d1Adapter(db));
  const reachedDocument = new Error("reached retained document");
  let calls = 0;
  const objects = {
    async get() {
      assert.equal(calls, 1);
      throw reachedDocument;
    },
  };
  try {
    for (let unit = 0; unit < 4; unit++) {
      calls = 0;
      async function* evidenceAfter(after) {
        for (let sequence = (after?.sequenceNumber ?? -1) + 1; sequence <= 17; sequence++) {
          calls++;
          yield {
            request: { sequence_number: sequence, request_id: `request-${sequence}` },
            row: sequence === 17 ? { content_byte_length: 1 } : null,
          };
        }
      }
      try {
        await prepareSourceDocuments(store, objects, "preparation", "digest", evidenceAfter, () => assert.fail(), true);
        assert.fail("document read must occur");
      } catch (error) {
        if (error.cause === reachedDocument) return;
        if (!(error instanceof ReconciliationContinuation)) throw error;
      }
    }
    assert.fail("the retained document was not reached");
  } finally {
    db.close();
  }
});

test("request graph traversal checkpoints unavailable selections before the next stage", async () => {
  const db = new DatabaseSync(":memory:");
  createSourceDocumentCheckpointTable(db);
  const store = catalogueStore(d1Adapter(db));
  const visited = [];
  try {
    for (let unit = 0; unit < 160; unit++) {
      let calls = 0;
      async function* evidenceAfter(after) {
        for (let sequence = (after?.sequenceNumber ?? -1) + 1; sequence < 1190; sequence++) {
          assert.ok(++calls <= 8);
          visited.push(sequence);
          yield { request: { sequence_number: sequence, request_id: `image-${sequence}` }, row: null };
        }
      }
      try {
        await assertClosedRequestGraph(
          store,
          "preparation",
          "digest",
          evidenceAfter,
          () => assert.fail(),
          () => assert.fail(),
          true,
        );
        assert.fail("the graph must checkpoint its stage transition");
      } catch (error) {
        if (!(error instanceof ReconciliationContinuation)) throw error;
        const cursor = await reconciliationCheckpoint(store, "preparation", "graph_validation");
        if (cursor.value.stage === "gundam_validation") {
          assert.deepEqual(
            visited,
            Array.from({ length: 1190 }, (_, i) => i),
          );
          return;
        }
      }
    }
    assert.fail("graph traversal did not finish");
  } finally {
    db.close();
  }
});
