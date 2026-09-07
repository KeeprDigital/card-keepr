import { createHash } from "node:crypto";
import { handoffPlan } from "./fresh-baseline-handoff.mjs";
const q = (value) => (value === null ? "NULL" : `'${String(value).replaceAll("'", "''")}'`);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const assert = (condition) =>
  `SELECT CASE WHEN ${condition} THEN 1 ELSE json_extract('{}','fresh_baseline_correction_guard_failed') END AS verified;`;
export function correctionPlan(environment) {
  const plan = handoffPlan(environment);
  const text = environment.HANDOFF_CORRECTION_JSON;
  const correction = JSON.parse(text ?? "null");
  if (
    !correction ||
    correction.contract !== "card-keepr-fresh-baseline-correction@1" ||
    correction.release_id !== plan.release_id ||
    correction.handoff_dispatch_digest !== environment.DISPATCH_DIGEST ||
    hash(text) !== environment.HANDOFF_CORRECTION_DIGEST ||
    correction.expected_head_sha !== environment.EXPECTED_HEAD_SHA ||
    !/^[0-9a-f]{40}$/.test(correction.expected_head_sha) ||
    !Number.isSafeInteger(correction.generation) ||
    correction.generation < 1 ||
    correction.generation > 100
  )
    throw new Error("invalid_fresh_baseline_correction");
  return correction;
}
export function correctionRowsSql(environment) {
  return `SELECT * FROM fresh_baseline_corrections WHERE handoff_dispatch_digest=${q(environment.DISPATCH_DIGEST)} ORDER BY generation LIMIT 101;`;
}
export function correctionImportSql(environment, records, existing) {
  const expected = correctionPlan(environment);
  if (records.length !== expected.generation || records.length > 100 || existing.length > records.length)
    throw new Error("fresh_baseline_correction_chain_invalid");
  let previous = null;
  const statements = [];
  for (const [index, row] of records.entries()) {
    const request = JSON.parse(row.request_json);
    const response = JSON.parse(row.response_json);
    if (
      request.contract !== "card-keepr-fresh-baseline-correction@1" ||
      request.release_id !== expected.release_id ||
      request.idempotency_key !== row.idempotency_key ||
      !/^[0-9a-f]{40}$/.test(request.expected_head_sha) ||
      response.dispatch_inputs?.expected_head_sha !== request.expected_head_sha ||
      row.handoff_dispatch_digest !== environment.DISPATCH_DIGEST ||
      row.generation !== index + 1 ||
      row.previous_correction_digest !== previous ||
      hash(row.request_json) !== row.correction_digest ||
      request.previous_correction_digest !== previous ||
      request.generation !== row.generation ||
      request.handoff_dispatch_digest !== environment.DISPATCH_DIGEST ||
      response.dispatch_inputs?.correction_json !== row.request_json ||
      response.dispatch_inputs?.correction_digest !== row.correction_digest ||
      response.dispatch_inputs?.operation !== "correct_fresh_baseline_handoff"
    )
      throw new Error("fresh_baseline_correction_chain_invalid");
    if (existing[index]) {
      if (
        existing[index].request_json !== row.request_json ||
        existing[index].response_json !== row.response_json ||
        existing[index].correction_digest !== row.correction_digest
      )
        throw new Error("fresh_baseline_correction_chain_conflict");
    } else
      statements.push(
        `INSERT INTO fresh_baseline_corrections(correction_digest,handoff_dispatch_digest,idempotency_key,generation,previous_correction_digest,request_json,response_json,state,evidence_json,created_at) VALUES(${q(row.correction_digest)},${q(row.handoff_dispatch_digest)},${q(row.idempotency_key)},${row.generation},${q(row.previous_correction_digest)},${q(row.request_json)},${q(row.response_json)},0,'[]',${q(row.created_at)});`,
      );
    previous = row.correction_digest;
  }
  if (
    previous !== environment.HANDOFF_CORRECTION_DIGEST ||
    records.at(-1).request_json !== environment.HANDOFF_CORRECTION_JSON
  )
    throw new Error("fresh_baseline_correction_superseded");
  return (
    statements.join("\n") +
    "\n" +
    assert(`EXISTS(SELECT 1 FROM fresh_baseline_corrections WHERE correction_digest=${q(previous)})`)
  );
}
export function claimCorrectionSql(environment) {
  const correction = correctionPlan(environment);
  const token = q(environment.HANDOFF_EXECUTION_ID);
  const latest = `correction_digest=${q(environment.HANDOFF_CORRECTION_DIGEST)} AND generation=(SELECT MAX(generation) FROM fresh_baseline_corrections WHERE handoff_dispatch_digest=${q(environment.DISPATCH_DIGEST)})`;
  return `UPDATE fresh_baseline_corrections SET execution_id=${token} WHERE ${latest} AND (execution_id IS NULL OR execution_id=${token} OR EXISTS(SELECT 1 FROM operation_state WHERE active_production_release_id=${q(correction.release_id)} AND active_production_release_expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')));
 ${assert(`EXISTS(SELECT 1 FROM fresh_baseline_corrections WHERE ${latest} AND execution_id=${token})`)}
 UPDATE fresh_baseline_handoffs SET execution_id=${token} WHERE dispatch_digest=${q(environment.DISPATCH_DIGEST)};
 UPDATE operation_state SET active_production_release_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+45 minutes') WHERE active_production_release_id=${q(correction.release_id)};
 ${assert(`EXISTS(SELECT 1 FROM fresh_baseline_handoffs h JOIN operation_state o ON o.active_production_release_id=h.release_id WHERE h.dispatch_digest=${q(environment.DISPATCH_DIGEST)} AND h.execution_id=${token} AND o.active_production_release_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)}`;
}
export function correctionPhaseSql(environment, from, evidence) {
  correctionPlan(environment);
  if (![0, 1].includes(from)) throw new Error("fresh_baseline_correction_phase_invalid");
  const digest = q(environment.HANDOFF_CORRECTION_DIGEST),
    token = q(environment.HANDOFF_EXECUTION_ID),
    encoded = q(JSON.stringify(evidence));
  return `UPDATE fresh_baseline_corrections SET state=${from + 1},evidence_json=json_insert(evidence_json,'$[#]',json(${encoded})) WHERE correction_digest=${digest} AND state=${from} AND execution_id=${token};
 ${assert(`EXISTS(SELECT 1 FROM fresh_baseline_corrections WHERE correction_digest=${digest} AND state=${from + 1} AND execution_id=${token} AND json_extract(evidence_json,'$[#-1]')=json(${encoded}))`)}`;
}

/** Same approved D1 pair, newly confirmed code; no second baseline/reset. */
export async function runFreshBaselineCorrection(environment, adapter) {
  const correction = correctionPlan(environment);
  const rows = {
    source: await adapter.correctionRows("source"),
    destination: await adapter.correctionRows("destination"),
  };
  const authority = rows.source.length >= rows.destination.length ? rows.source : rows.destination;
  for (const role of ["source", "destination"]) await adapter.importCorrection(role, authority, rows[role]);
  const initialSource = await adapter.read("source"),
    initialDestination = await adapter.read("destination");
  if (
    initialSource?.phase === 6 &&
    initialDestination?.phase === 6 &&
    rows.source.at(-1)?.state === 2 &&
    rows.destination.at(-1)?.state === 2
  )
    return {
      release_id: correction.release_id,
      state: "handoff_accepted",
      correction_digest: environment.HANDOFF_CORRECTION_DIGEST,
      go_live: false,
      source_retained: true,
    };
  for (const role of ["source", "destination"]) await adapter.claimCorrection(role);
  const latest = async (role) => (await adapter.correctionRows(role)).at(-1);
  let source = await latest("source"),
    destination = await latest("destination");
  if (source.state === 0 || destination.state === 0) {
    const versions = await adapter.uploadAndVerify();
    const evidence = { versions, correction_digest: environment.HANDOFF_CORRECTION_DIGEST };
    for (const [role, row] of [
      ["source", source],
      ["destination", destination],
    ]) {
      if (row.state === 0) await adapter.correctionPhase(role, 0, evidence);
      else if (JSON.stringify(JSON.parse(row.evidence_json)[0]) !== JSON.stringify(evidence))
        throw new Error("fresh_baseline_correction_intent_changed");
    }
  }
  source = await latest("source");
  destination = await latest("destination");
  if (source.state === 1 || destination.state === 1) {
    const intent = JSON.parse(source.evidence_json)[0];
    if (JSON.stringify(intent) !== JSON.stringify(JSON.parse(destination.evidence_json)[0]))
      throw new Error("fresh_baseline_correction_intent_changed");
    await adapter.activate(intent.versions);
    const observed = {
      binding: await adapter.observe(intent.versions),
      smoke: await adapter.smoke(),
      correction_digest: environment.HANDOFF_CORRECTION_DIGEST,
    };
    if (source.state === 1) await adapter.correctionPhase("source", 1, observed);
    if (destination.state === 1) await adapter.correctionPhase("destination", 1, observed);
  }
  source = await adapter.read("source");
  destination = await adapter.read("destination");
  for (const [role, row] of [
    ["source", source],
    ["destination", destination],
  ])
    if (row.phase === 4)
      await adapter.advance(role, 4, { verified_correction_digest: environment.HANDOFF_CORRECTION_DIGEST });
  source = await adapter.read("source");
  if (source.phase === 5)
    await adapter.advance("source", 5, {
      retired: true,
      verified_correction_digest: environment.HANDOFF_CORRECTION_DIGEST,
    });
  source = await adapter.read("source");
  destination = await adapter.read("destination");
  if (source.phase !== 6) throw new Error("fresh_baseline_source_not_retired");
  if (destination.phase === 5) await adapter.accept(source);
  if ((await adapter.read("destination")).phase !== 6) throw new Error("fresh_baseline_destination_not_accepted");
  return {
    release_id: correction.release_id,
    state: "handoff_accepted",
    correction_digest: environment.HANDOFF_CORRECTION_DIGEST,
    go_live: false,
    source_retained: true,
  };
}
