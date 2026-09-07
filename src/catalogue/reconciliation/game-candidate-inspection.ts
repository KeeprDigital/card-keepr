import { AdministrationProblem, canonicalJson, sha256Text, type CatalogueStore } from "../shared";
import { ReconciliationReducerIndex } from "./reconciliation-reducer-state";
import { gameCandidatePartitionStatement, predecessorGameCandidateStatement } from "./game-candidate-repository";

type Envelope = { contract: string; value: unknown; text_parts: unknown[] };
type Entry = { id: string; entity_id: string; kind: string; envelope: Envelope };
export type InspectionCursor = {
  stage: "before" | "after" | "removed" | "complete";
  predecessor: { id: string; preparation_id: string; partition_count: number } | null;
  partition: number;
  record: number;
  beforePosition: number;
  afterPosition: number;
  after: string;
  count: number;
  counts: Record<string, Record<string, number>>;
};

export async function verifiedCandidatePartition(database: CatalogueStore, id: string, ordinal: number) {
  const row = await gameCandidatePartitionStatement(database, id, ordinal).first<{
    content: string;
    kind: string;
    sha256: string;
    byte_length: number;
    record_count: number;
  }>();
  if (!row)
    throw new AdministrationProblem(409, "candidate_artifact_missing", "A required candidate partition is missing.");
  if (
    row.byte_length > 524288 ||
    new TextEncoder().encode(row.content).byteLength !== row.byte_length ||
    (await sha256Text(row.content)) !== row.sha256
  )
    throw new AdministrationProblem(
      409,
      "candidate_artifact_invalid",
      "A required candidate partition failed integrity verification.",
    );
  let records: Envelope[];
  try {
    records = JSON.parse(row.content);
  } catch {
    throw new AdministrationProblem(409, "candidate_artifact_invalid", "A required candidate partition is malformed.");
  }
  if (
    !Array.isArray(records) ||
    records.length !== row.record_count ||
    records.some(
      (record) => record?.contract !== "card-keepr-partitioned-record@1" || !Array.isArray(record.text_parts),
    )
  )
    throw new AdministrationProblem(
      409,
      "candidate_artifact_invalid",
      "A required candidate partition has invalid record receipts.",
    );
  return { ...row, records };
}

/** Continue at individual records; neither predecessor nor proposed game is buffered. */
export async function prepareCandidateInspection(
  database: CatalogueStore,
  candidate: { id: string; preparation_id: string; supported_game: string; expected_game_revision_id: string },
  state: InspectionCursor | undefined,
  partitionCount: number,
  save: (cursor: InspectionCursor) => Promise<void>,
  append: (values: unknown[]) => Promise<void>,
) {
  const cursor: InspectionCursor = state ?? {
    stage: "before",
    predecessor: await predecessorGameCandidateStatement(
      database,
      candidate.expected_game_revision_id,
      candidate.supported_game,
    ).first(),
    partition: 0,
    record: 0,
    beforePosition: 0,
    afterPosition: 0,
    after: "",
    count: 0,
    counts: {},
  };
  if (!cursor.predecessor && candidate.expected_game_revision_id !== "catrev_spine_000")
    throw new Error("The exact predecessor candidate required for inspection is unavailable.");
  const before = new ReconciliationReducerIndex<Entry>(
    database,
    candidate.preparation_id,
    `inspection_before:${candidate.id}`,
  );
  const after = new ReconciliationReducerIndex<Entry>(
    database,
    candidate.preparation_id,
    `inspection_after:${candidate.id}`,
  );
  before.resumeAt(cursor.beforePosition);
  after.resumeAt(cursor.afterPosition);
  let pending: unknown[] = [];
  let work = 0;
  let bytes = 0;
  const retain = async () => {
    if (pending.length) {
      await append(pending);
      pending = [];
    }
    work = 0;
    bytes = 0;
    cursor.beforePosition = before.position;
    cursor.afterPosition = after.position;
    await save(cursor);
  };
  const emit = async (left: Entry | undefined, right: Entry | undefined) => {
    const entry = right ?? left!;
    const change = !left
      ? "added"
      : !right
        ? "removed"
        : canonicalJson(left.envelope) === canonicalJson(right.envelope)
          ? "carry_forward"
          : canonicalJson(semantic(left)) === canonicalJson(semantic(right))
            ? "evidence_only"
            : "changed";
    cursor.counts[entry.kind] ??= {};
    cursor.counts[entry.kind]![change] = (cursor.counts[entry.kind]![change] ?? 0) + 1;
    pending.push({
      game: candidate.supported_game,
      entity_class: entry.kind,
      entity_id: entry.entity_id,
      change,
      expected_game_revision_id: candidate.expected_game_revision_id,
      before: left?.envelope.value ?? null,
      after: right?.envelope.value ?? null,
      before_text: {
        candidate_id: cursor.predecessor?.id ?? null,
        preparation_id: cursor.predecessor?.preparation_id ?? null,
        parts: left?.envelope.text_parts ?? [],
      },
      after_text: {
        candidate_id: candidate.id,
        preparation_id: candidate.preparation_id,
        parts: right?.envelope.text_parts ?? [],
      },
    });
    cursor.count++;
    bytes += new TextEncoder().encode(canonicalJson(pending.at(-1))).byteLength;
  };
  for (const stage of ["before", "after"] as const) {
    if (cursor.stage !== stage) continue;
    const source = stage === "before" ? cursor.predecessor?.id : candidate.id;
    const count = stage === "before" ? (cursor.predecessor?.partition_count ?? 0) : partitionCount;
    for (; source && cursor.partition < count; ) {
      const page = await verifiedCandidatePartition(database, source, cursor.partition);
      if (page.kind !== "inspection" && page.kind !== "inspection_summary") {
        for (; cursor.record < page.records.length; ) {
          const envelope = page.records[cursor.record]!;
          const value = envelope.value as Record<string, unknown>;
          const id =
            typeof value === "object" && value !== null
              ? typeof value.id === "string"
                ? value.id
                : page.kind === "source_checks"
                  ? canonicalJson([value.game, value.area])
                  : canonicalJson(value)
              : canonicalJson(value);
          const key = `${page.kind}:${id}`;
          const entry = { id: key, entity_id: id, kind: page.kind, envelope };
          if (stage === "before") await before.seed(key, entry);
          else {
            await emit(await before.get(key), entry);
            if (cursor.predecessor) await after.seed(key, entry);
          }
          cursor.record++;
          if ((++work >= (cursor.predecessor ? 4 : 32) || bytes >= 128000) && cursor.record < page.records.length)
            await retain();
        }
      }
      cursor.record = 0;
      cursor.partition++;
      await retain();
    }
    cursor.partition = 0;
    cursor.stage = stage === "before" ? "after" : "removed";
    await retain();
  }
  if (cursor.stage === "removed") {
    for await (const entry of before.entityValues(cursor.after)) {
      const key = entry.id;
      if (!(await after.get(key))) await emit(entry, undefined);
      // Reducer entityValues orders its explicit id field.
      cursor.after = entry.id;
      if (++work >= 4) await retain();
    }
    cursor.stage = "complete";
    await retain();
  }
  return cursor;
}

function semantic(entry: Entry) {
  const evidence = new Set([
    "source_url",
    "source_observations",
    "source_observation_ids",
    "included",
    "provenance",
    "curated_provenance",
    "observed",
    "source_lineages",
    "source_lineage",
    "checked_at",
  ]);
  const strip = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(strip)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([key]) => !evidence.has(key))
              .map(([key, child]) => [key, strip(child)]),
          )
        : value;
  return {
    value: strip(entry.envelope.value),
    text_parts: entry.envelope.text_parts.filter((part) => {
      const path = (part as { path: (string | number)[] }).path;
      return !path.some((segment) => typeof segment === "string" && evidence.has(segment));
    }),
  };
}

export async function inspectCandidateEvidence(
  database: CatalogueStore,
  candidate: {
    id: string;
    preparation_id: string;
    supported_game: string;
    manifest_digest: string | null;
    expected_game_revision_id: string;
  },
  kind: string,
  after: string | null,
  manifest: string | null,
) {
  if (
    (manifest !== null && manifest !== candidate.manifest_digest) ||
    (after !== null && !after.startsWith(`${candidate.manifest_digest}:${kind}:`))
  )
    throw new AdministrationProblem(409, "candidate_pin_mismatch", "Use evidence from the exact candidate manifest.");
  const key = after === null ? "" : after.slice(66 + kind.length);
  const row = await inspectionEvidenceStatement(
    database,
    candidate.preparation_id,
    candidate.supported_game,
    kind,
    key,
  ).first<{ id: string; document_json: string }>();
  if (row && new TextEncoder().encode(row.document_json).byteLength > 1048000)
    throw new AdministrationProblem(
      409,
      "candidate_artifact_invalid",
      "The retained evidence exceeds the bounded inspection page.",
    );
  return {
    contract: "card-keepr-candidate-evidence@1",
    candidate_id: candidate.id,
    manifest_digest: candidate.manifest_digest,
    expected_game_revision_id: candidate.expected_game_revision_id,
    evidence_class: kind,
    records: row ? [JSON.parse(row.document_json)] : [],
    next_cursor: row ? `${candidate.manifest_digest}:${kind}:${row.id}` : null,
  };
}
import { inspectionEvidenceStatement } from "./game-inspection-evidence-repository";

export async function candidateImageContent(
  database: CatalogueStore,
  bucket: R2Bucket,
  candidateId: string,
  ordinal: string,
  record: string,
) {
  if (
    !/^\d+$/.test(ordinal) ||
    !/^\d+$/.test(record) ||
    !Number.isSafeInteger(Number(ordinal)) ||
    !Number.isSafeInteger(Number(record))
  )
    throw new AdministrationProblem(
      422,
      "invalid_image_reference",
      "Use a candidate partition and image record ordinal.",
    );
  const partition = await verifiedCandidatePartition(database, candidateId, Number(ordinal));
  const image = partition.records[Number(record)]?.value as
    | { object_key: string; content_sha256: string; content_byte_length: number; media_type: string }
    | undefined;
  if (partition.kind !== "printing_images" || !image)
    throw new AdministrationProblem(404, "candidate_image_not_found", "This partition record is not a Printing Image.");
  const object = await bucket.get(image.object_key);
  if (!object)
    throw new AdministrationProblem(409, "candidate_artifact_missing", "A required Printing Image is missing.");
  if (object.size !== image.content_byte_length) {
    await object.body.cancel();
    throw new AdministrationProblem(
      409,
      "candidate_artifact_invalid",
      "A required Printing Image has an invalid byte length.",
    );
  }
  const digest = new crypto.DigestStream("SHA-256");
  await object.body.pipeTo(digest);
  const actual = Array.from(new Uint8Array(await digest.digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (actual !== image.content_sha256)
    throw new AdministrationProblem(
      409,
      "candidate_artifact_invalid",
      "A required Printing Image failed digest verification.",
    );
  const content = await bucket.get(image.object_key, { onlyIf: { etagMatches: object.etag } });
  if (!content || !("body" in content))
    throw new AdministrationProblem(409, "candidate_artifact_invalid", "The Printing Image changed during inspection.");
  return new Response(content.body, {
    headers: {
      "content-type": image.media_type,
      "content-length": String(image.content_byte_length),
      "cache-control": "private, no-store",
      etag: `"${image.content_sha256}"`,
    },
  });
}
