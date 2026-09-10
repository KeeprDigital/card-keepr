import { type CatalogueStore, sha256Text } from "../shared";
import { documentStorage } from "./reconciliation-document";
import { canonicalValueDigest } from "./reconciliation-preparation";
import type { EvidencePlanRow } from "./reconciliation-evidence-types";
import type { EvidenceSelection } from "./reconciliation-evidence-types";
import {
  reconciliationEvidencePlanStatement,
  currentSourceDigestStatement,
  currentSourceRequestCountStatement,
  unchangedAcceptedSourceStatement,
} from "./reconciliation-evidence-repository";
import { sourceHistoryCandidateStatement } from "./native-source-history-repository";
import { reconciliationCheckpoint } from "./reconciliation-checkpoint";
import { ReconciliationReducerIndex } from "./reconciliation-reducer-state";
import { retainedEvidenceSelection } from "./reconciliation-selection";

export type AcceptedSourceCursor = {
  candidate: string | null;
  next: string | null;
  game: string;
  stage: "walk" | "requests" | "complete";
  after: { sequenceNumber: number; requestId: string; complete: boolean };
  selected: number;
  expected: number;
  scanned: number;
  digest: string;
  expectedDigest: string;
  visited: number;
  unchanged: boolean;
};

/** Compare with the latest selected scope in the captured accepted chain, in resumable metadata units. */
export async function advanceAcceptedSource(
  db: CatalogueStore,
  preparation: string,
  lineage: string,
  adapter: string,
  cursor?: AcceptedSourceCursor,
): Promise<AcceptedSourceCursor> {
  if (!cursor) {
    const current = await documentStorage(() =>
      sourceHistoryCandidateStatement(db, preparation).first<{
        id: string;
        pin_id: string | null;
        predecessor_candidate_id: string | null;
        supported_game: string;
      }>(),
    );
    if (current && current.pin_id !== current.id)
      throw new Error("Native source verification is missing its captured predecessor.");
    cursor = {
      candidate: current?.predecessor_candidate_id ?? null,
      next: null,
      game: current?.supported_game ?? "",
      stage: "walk",
      after: { sequenceNumber: -1, requestId: "", complete: true },
      selected: 0,
      expected: 0,
      scanned: 0,
      digest: "",
      expectedDigest: "",
      visited: 0,
      unchanged: false,
    };
  }
  const namespace = `accepted_source_${await sha256Text(JSON.stringify([lineage, adapter]))}`;
  const visited = new ReconciliationReducerIndex<boolean>(db, preparation, namespace);
  visited.resumeAt(cursor.visited);
  if (cursor.stage === "walk") {
    if (cursor.candidate === null) {
      // The immutable native chain ends at the legacy publication boundary.
      cursor.unchanged = Boolean(
        await documentStorage(() => unchangedAcceptedSourceStatement(db, preparation, lineage, adapter).first()),
      );
      cursor.stage = "complete";
    } else {
      if (await visited.has(cursor.candidate)) throw new Error("Native source verification found a predecessor cycle.");
      const candidate = await documentStorage(() =>
        sourceHistoryCandidateStatement(db, cursor!.candidate!).first<{
          id: string;
          preparation_id: string;
          pin_id: string | null;
          supported_game: string;
          predecessor_candidate_id: string | null;
          catalogue_revision_id: string | null;
        }>(),
      );
      if (
        !candidate ||
        candidate.id !== candidate.preparation_id ||
        candidate.pin_id !== candidate.id ||
        candidate.supported_game !== cursor.game ||
        candidate.catalogue_revision_id === null
      )
        throw new Error("Native source verification is missing its exact published predecessor.");
      const selection = await reconciliationCheckpoint<{
        stage: string;
        requestCount: number;
        inputDigest: string;
        omittedLineages: string[];
      }>(db, candidate.id, "source_selection");
      if (
        selection?.value.stage !== "complete" ||
        !Number.isSafeInteger(selection.value.requestCount) ||
        selection.value.requestCount <= 0
      )
        throw new Error("Native source verification requires a complete retained evidence selection.");
      const evidencePlanRow = await documentStorage(() =>
        reconciliationEvidencePlanStatement(db, candidate.id).first<EvidencePlanRow>(),
      );
      if (!evidencePlanRow) throw new Error("Native source verification is missing its immutable evidence plan.");
      cursor.digest = await canonicalValueDigest({ evidencePlanRow, omittedLineages: selection.value.omittedLineages });
      cursor.expectedDigest = selection.value.inputDigest;
      cursor.expected = selection.value.requestCount;
      cursor.scanned = 0;
      await visited.seed(candidate.id, true);
      cursor.next = candidate.predecessor_candidate_id;
      cursor.after = { sequenceNumber: -1, requestId: "", complete: true };
      cursor.selected = 0;
      cursor.stage = "requests";
    }
  } else {
    const next = await retainedEvidenceSelection<EvidenceSelection>(db, cursor.candidate!, cursor.after).next();
    if (next.done) {
      if (cursor.scanned !== cursor.expected)
        throw new Error("Native source verification is missing retained evidence requests.");
      if (cursor.digest !== cursor.expectedDigest)
        throw new Error("Native source verification differs from its completed selection digest.");
      if (cursor.selected > 0) {
        const count = await documentStorage(() =>
          currentSourceRequestCountStatement(db, preparation, lineage, adapter).first<number>("count"),
        );
        cursor.unchanged = count === cursor.selected;
        cursor.stage = "complete";
      } else {
        cursor.candidate = cursor.next;
        cursor.stage = "walk";
      }
    } else {
      const { request, row } = next.value;
      cursor.scanned++;
      if (row) cursor.digest = await canonicalValueDigest({ previous: cursor.digest, evidence: { request, row } });
      if (row?.source_lineage === lineage && request.request_role !== "image") {
        cursor.selected++;
        const digest = await documentStorage(() =>
          currentSourceDigestStatement(db, preparation, lineage, adapter, request.request_id).first<string>(
            "content_digest",
          ),
        );
        if (row.adapter_version !== adapter || digest !== row.snapshot_content_digest) cursor.stage = "complete";
      }
      cursor.after = { sequenceNumber: request.sequence_number, requestId: request.request_id, complete: true };
    }
  }
  cursor.visited = visited.position;
  return cursor;
}
