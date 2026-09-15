import { putImmutableEvidenceBytes } from "./source-evidence-object";
import { decodeArchiveBatch } from "./source-archive-decode";
import { parseArchiveBatch } from "./source-archive-parse";
import { SourceArchiveFailure } from "../shared";
import { sourceParseAuthorityGuard, type SourceParseAuthority } from "./source-parse-authority-repository";
import { retainSourceRecordManifest } from "./source-record-manifest";
import { retainedParentContext } from "./source-parent-context";
import { retainExtractedSourceRecords, verifiedSnapshotChunks } from "./source-record-intake";
import { sealSourceRecords } from "./source-record-repository";
import {
  beginEvidenceObjectWrite,
  completeEvidenceObjectWrite,
  completeObservedEvidenceWrite,
} from "./evidence-cleanup-repository";
import {
  extractBoundedAdapterPage,
  type SourceAdapterRegistration,
  AdapterParseFailure,
  assertAdapterBinding,
  assertAdapterRequestSurface,
  requiredSourceAdapter,
} from "../adapters";
import { AdministrationProblem, type CatalogueStore, canonicalJson, sha256, utf8 } from "../shared";
import type { SourceRequestRole } from "./source-evidence-model";
import { publicObservationSet } from "./source-evidence-repository";
import type { ObservationSetRow, SnapshotRow } from "./source-evidence-repository-types";
import {
  createParseOperationStatement,
  finalizedObservationSetStatement,
  finalizeParseStatement,
  observationSetByParseOperationStatement,
  parseOperationStatement,
  uploadedParseStatement,
  sourceSnapshotForParsingStatement,
} from "./source-parse-repository";

type ParseOperationRow = {
  id: string;
  source_snapshot_id: string;
  adapter_version: string;
  intent: "collection" | "reparse";
  idempotency_key: string;
  observation_set_id: string;
  content_object_key: string;
  parsed_at: string;
  state: "planned" | "uploaded" | "finalized";
  content_digest: string | null;
  content_byte_length: number | null;
  observation_count: number | null;
};

type ParseIntent = {
  intent: "collection" | "reparse";
  idempotencyKey: string;
  workflowAttempt?: SourceParseAuthority["workflowAttempt"];
};

export async function parseSnapshot(
  database: CatalogueStore,
  evidenceObjects: R2Bucket,
  snapshotId: string,
  adapterVersion: string,
  parseIntent: ParseIntent,
): Promise<ObservationSetRow> {
  const result = await parseSnapshotBatch(database, evidenceObjects, snapshotId, adapterVersion, parseIntent);
  if ("kind" in result)
    throw new AdministrationProblem(
      409,
      "source_parse_in_progress",
      "Source parsing has retained progress and requires continuation.",
    );
  return result;
}

type ParsePending = {
  kind: "pending";
  parse_operation_id: string;
  observation_set_id: string;
  phase: "decoding" | "normalizing";
};

export async function parseSnapshotBatch(
  database: CatalogueStore,
  evidenceObjects: R2Bucket,
  snapshotId: string,
  adapterVersion: string,
  parseIntent: ParseIntent,
): Promise<ObservationSetRow | ParsePending> {
  const snapshot = await sourceSnapshotForParsingStatement(database, snapshotId).first<
    SnapshotRow & { request_role: SourceRequestRole; discovered_from_request_id: string | null }
  >();
  if (snapshot === null) {
    throw new AdministrationProblem(404, "source_snapshot_not_found", "The requested Source Snapshot does not exist.");
  }
  const adapter = requiredSourceAdapter(adapterVersion);
  if (adapter.adapterVersion !== snapshot.adapter_version) {
    throw new AdministrationProblem(
      422,
      "source_snapshot_adapter_mismatch",
      "A Source Snapshot can only be parsed with its exact capturing adapter version.",
    );
  }
  assertAdapterBinding(adapter, {
    sourceLineage: snapshot.source_lineage,
    supportedGame: snapshot.supported_game,
    gameProfileVersion: snapshot.game_profile_version,
  });
  assertAdapterRequestSurface(adapter, new URL(snapshot.request_url));
  const archive =
    snapshot.request_role === "listing" &&
    adapter.archiveExtraction?.matches({ url: snapshot.request_url, requestId: snapshot.request_id })
      ? adapter.archiveExtraction
      : undefined;
  if (snapshot.content_byte_length > (archive?.maximumSnapshotBytes ?? adapter.maximumSnapshotBytes)) {
    throw new AdministrationProblem(
      422,
      "source_parse_too_large",
      "The Source Snapshot exceeds the adapter's bounded parse limit.",
    );
  }
  const guard = archive ? () => sourceParseAuthorityGuard(database, snapshot.ingestion_run_id, parseIntent) : undefined;
  const operation = await prepareParseOperation(database, snapshot.id, adapter.adapterVersion, parseIntent, guard);
  if (operation.state === "finalized") {
    return requiredObservationSet(database, operation.id);
  }
  if (operation.state === "uploaded") {
    return finalizeParseOperation(database, operation.id, snapshot, guard);
  }
  const header = {
    contract: "card-keepr-source-observations@1",
    id: operation.observation_set_id,
    source_snapshot_id: snapshot.id,
    source_lineage: snapshot.source_lineage,
    supported_game: snapshot.supported_game,
    game_profile_version: snapshot.game_profile_version,
    adapter_version: adapter.adapterVersion,
    parsed_at: operation.parsed_at,
    coverage_proof:
      adapter.reconciliationCapability !== "unavailable"
        ? {
            kind: adapter.reconciliationCapability,
            adapter_version: adapter.adapterVersion,
            parser_contract: adapter.parserContract,
          }
        : null,
  };
  let observationDocument: Record<string, unknown>;
  let observationCount: number;
  try {
    const image = snapshot.request_role === "image";
    const parents = image
      ? undefined
      : await retainedParentContext(database, evidenceObjects, snapshot, adapter, operation.id);
    const interpretationHeader = {
      ...header,
      ...(parents === undefined
        ? {}
        : { discovery_context: parents.map(({ bytes: _bytes, ...reference }) => reference) }),
    };
    const context = {
      url: snapshot.request_url,
      mediaType: snapshot.media_type,
      requestId: snapshot.request_id,
      parents,
    };
    if (!image && snapshot.media_type?.startsWith("image/"))
      throw new AdapterParseFailure("A catalogue document request cannot retain an image response as card facts.");
    if (archive) {
      const pin = archive.pin({
        url: snapshot.request_url,
        requestId: snapshot.request_id,
        compressedBytes: snapshot.content_byte_length,
      });
      const decoded = await decodeArchiveBatch(database, evidenceObjects, snapshot, pin, guard!);
      if (decoded.state !== "decoded")
        return {
          kind: "pending",
          parse_operation_id: operation.id,
          observation_set_id: operation.observation_set_id,
          phase: "decoding",
        };
      const document = await parseArchiveBatch(
        database,
        evidenceObjects,
        operation.observation_set_id,
        interpretationHeader,
        decoded,
        archive,
        pin.cutoff,
        guard!,
      );
      if (document === null)
        return {
          kind: "pending",
          parse_operation_id: operation.id,
          observation_set_id: operation.observation_set_id,
          phase: "normalizing",
        };
      observationDocument = document;
      observationCount = (document.record_storage as { count: number }).count;
    } else {
      let extraction: Awaited<ReturnType<NonNullable<SourceAdapterRegistration["recordExtraction"]>["extract"]>>;
      if (image) {
        if (!snapshot.media_type?.startsWith("image/") || snapshot.content_byte_length === 0)
          throw new AdapterParseFailure("Official Printing Image request did not retain non-empty image bytes.");
        for await (const _chunk of verifiedSnapshotChunks(evidenceObjects, snapshot, false)) {
          /* verify raw bytes */
        }
        extraction = { count: 0, pagination: null, requests: [], records: (async function* () {})() };
      } else
        extraction = adapter.recordExtraction?.matches(context)
          ? await adapter.recordExtraction.extract(() => verifiedSnapshotChunks(evidenceObjects, snapshot), context)
          : await extractBoundedAdapterPage(adapter, () => verifiedSnapshotChunks(evidenceObjects, snapshot), context);
      observationDocument = await retainExtractedSourceRecords(
        database,
        operation.observation_set_id,
        interpretationHeader,
        {
          ...extraction,
          requests: (async function* () {
            const inherited: unknown = JSON.parse(snapshot.request_headers_json);
            for await (const request of extraction.requests) {
              if (
                !isRecord(inherited) ||
                (request.discoveryKey === undefined && adapter.inheritDiscoveryRequestHeaders !== true)
              ) {
                yield request;
                continue;
              }
              const headers = {
                ...request.headers,
                ...Object.fromEntries(
                  Object.entries(inherited).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
                ),
              };
              if (request.headers.accept !== undefined) headers.accept = request.headers.accept;
              yield { ...request, headers: discoveredRequestHeaders(request, headers) };
            }
          })(),
        },
      );
      observationCount = extraction.count;
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("source_parse_authority_superseded")) {
      const superseded = new Error("The collection parse authority has been superseded.");
      superseded.name = "SupersededCollectionWorkflowAttempt";
      throw superseded;
    }
    if (error instanceof SourceArchiveFailure)
      throw new AdministrationProblem(422, "source_parse_failed", error.message);
    if (!(error instanceof AdapterParseFailure) || error.category !== "source-contract") throw error;
    throw new AdministrationProblem(422, "source_parse_failed", error.message);
  }
  {
    const observationBytes = utf8(canonicalJson(observationDocument));
    const digest = await sha256(observationBytes);
    await retainSourceRecordManifest(database, operation.observation_set_id, observationDocument, guard);
    const writeToken = crypto.randomUUID();
    const observedToken = await putImmutableEvidenceBytes(
      evidenceObjects,
      operation.content_object_key,
      observationBytes,
      digest,
      writeToken,
      async () => {
        await database.batch([
          ...(guard ? [guard()] : []),
          beginEvidenceObjectWrite(
            database,
            writeToken,
            snapshot.ingestion_run_id,
            operation.content_object_key,
            new Date().toISOString(),
          ),
        ]);
      },
    );
    if (observedToken && observedToken !== writeToken)
      await completeObservedEvidenceWrite(
        database,
        observedToken,
        snapshot.ingestion_run_id,
        operation.content_object_key,
        new Date().toISOString(),
      ).run();
    await completeEvidenceObjectWrite(database, writeToken, new Date().toISOString()).run();
    await database.batch([
      ...(guard ? [guard()] : []),
      uploadedParseStatement(database, {
        digest: digest,
        byteLength: observationBytes.byteLength,
        observationCount,
        operationId: operation.id,
      }),
    ]);
  }
  return finalizeParseOperation(database, operation.id, snapshot, guard);
}

function discoveredRequestHeaders(
  request: { role: "listing" | "detail" | "product_detail" | "image" },
  headers: Record<string, string>,
): Record<string, string> {
  const baseUserAgent = (headers["user-agent"] ?? "card-keepr-official-source/1").replace(
    /;\s*request-role=(?:surface|listing|detail|product_detail|image)(?=;|$)/gu,
    "",
  );
  return {
    ...headers,
    "user-agent": `${baseUserAgent}; request-role=${request.role}`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function reparseSnapshot(
  database: CatalogueStore,
  evidenceObjects: R2Bucket,
  snapshotId: string,
  adapterVersion: string,
  idempotencyKey: string,
): Promise<Record<string, unknown>> {
  const result = await parseSnapshotBatch(database, evidenceObjects, snapshotId, adapterVersion, {
    intent: "reparse",
    idempotencyKey,
  });
  return "kind" in result
    ? { source_snapshot_id: snapshotId, adapter_version: adapterVersion, ...result }
    : publicObservationSet(result);
}

async function prepareParseOperation(
  database: CatalogueStore,
  snapshotId: string,
  adapterVersion: string,
  parseIntent: ParseIntent,
  guard?: () => D1PreparedStatement,
): Promise<ParseOperationRow> {
  const digest = await sha256(
    utf8(
      canonicalJson({
        source_snapshot_id: snapshotId,
        adapter_version: adapterVersion,
        intent: parseIntent.intent,
        idempotency_key: parseIntent.idempotencyKey,
      }),
    ),
  );
  const id = `srcparse_${digest}`;
  const observationSetId = `srcobsset_${digest}`;
  await database.batch([
    ...(guard ? [guard()] : []),
    createParseOperationStatement(database, {
      operationId: id,
      snapshotId: snapshotId,
      adapterVersion: adapterVersion,
      intent: parseIntent.intent,
      idempotencyKey: parseIntent.idempotencyKey,
      observationSetId: observationSetId,
      objectKey: `source-observations/${observationSetId}.json`,
      parsedAt: new Date().toISOString(),
    }),
  ]);
  return requiredParseOperation(database, id);
}

async function finalizeParseOperation(
  database: CatalogueStore,
  operationId: string,
  snapshot: SnapshotRow,
  guard?: () => D1PreparedStatement,
): Promise<ObservationSetRow> {
  const operation = await requiredParseOperation(database, operationId);
  if (operation.state === "finalized") {
    return requiredObservationSet(database, operation.id);
  }
  if (
    operation.state !== "uploaded" ||
    operation.content_digest === null ||
    operation.content_byte_length === null ||
    operation.observation_count === null
  ) {
    throw new Error("Parse operation upload metadata is incomplete");
  }
  await database.batch([
    ...(guard ? [guard()] : []),
    finalizedObservationSetStatement(database, {
      observationSetId: operation.observation_set_id,
      operationId: operation.id,
      snapshotId: snapshot.id,
      sourceLineage: snapshot.source_lineage,
      supportedGame: snapshot.supported_game,
      gameProfileVersion: snapshot.game_profile_version,
      adapterVersion: operation.adapter_version,
      parsedAt: operation.parsed_at,
      digest: operation.content_digest,
      byteLength: operation.content_byte_length,
      objectKey: operation.content_object_key,
      observationCount: operation.observation_count,
    }),
    sealSourceRecords(database, operation.observation_set_id),
    finalizeParseStatement(database, operation.id),
  ]);
  return requiredObservationSet(database, operation.id);
}

async function requiredParseOperation(database: CatalogueStore, id: string): Promise<ParseOperationRow> {
  const operation = await parseOperationStatement(database, id).first<ParseOperationRow>();
  if (operation === null) throw new Error("Parse operation disappeared");
  return operation;
}

async function requiredObservationSet(database: CatalogueStore, operationId: string): Promise<ObservationSetRow> {
  const stored = await observationSetByParseOperationStatement(database, operationId).first<ObservationSetRow>();
  if (stored === null) throw new Error("Source Observation Set disappeared");
  return stored;
}
