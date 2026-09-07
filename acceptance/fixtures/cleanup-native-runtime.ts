export { CatalogueBackupWorkflow,EvidenceHostWorkflow,EvidenceIngestionWorkflow,OfficialSourceTransport,ReconciliationWorkflow } from '../../apps/ingestion/src/index';
import ingestion from '../../apps/ingestion/src/index';
import {sha256Text} from '../../src/catalogue/shared';

/** Only this local fixture adds seed access; all cleanup/publication/recovery
 * requests still execute the shipped owner Worker and Workflows. */
export default {
 async fetch(request:Request,env:Env,ctx?:ExecutionContext) {
  if(new URL(request.url).pathname==='/acceptance/unused-cleanup-capture' && request.method==='POST' && request.headers.get('authorization')===`Bearer ${env.ADMINISTRATION_KEY}`){
   const id='srcsnap_cleanup_native',run='run_cleanup_native',key=`source-snapshots/${id}.bin`,body='synthetic unused terminal capture';
   const db=env.CATALOGUE_DB;
   const adapter=await db.prepare(`SELECT * FROM source_adapter_versions WHERE source_lineage='digimon-en'`).first<{adapter_version:string;game_profile_version:string}>();
   if(!adapter) throw new Error('Missing fixture adapter');
   await db.batch([
    db.prepare(`INSERT INTO ingestion_runs(id,started_at,expected_current_revision_id,idempotency_key) VALUES (?,'2026-01-01T00:00:00.000Z','catrev_spine_000',?)`).bind(run,run),
    db.prepare(`INSERT INTO ingestion_run_current(ingestion_run_id,last_event_sequence,last_event_id,state,completed_stage_count,terminal_at) VALUES (?,1,?,'failed',0,'2026-01-01T00:00:00.000Z')`).bind(run,run),
    db.prepare(`INSERT INTO source_requests(ingestion_run_id,request_id,sequence_number,method,url,request_headers_json,representation_fingerprint,state) VALUES (?,'unused',1,'GET','https://source.invalid/unused','{}','fixture','captured')`).bind(run),
    db.prepare(`INSERT INTO source_capture_operations(attempt_id,ingestion_run_id,request_id,attempt_number,source_snapshot_id,content_object_key,state,requested_at) VALUES (?,?, 'unused',1,?,?,'finalized','2026-01-01T00:00:00.000Z')`).bind(id,run,id,key),
    db.prepare(`INSERT INTO source_fetch_attempts(id,ingestion_run_id,request_id,attempt_number,requested_at,completed_at,outcome,response_headers_json) VALUES (?,?,'unused',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','success','{}')`).bind(id,run),
    db.prepare(`INSERT INTO source_snapshots(id,ingestion_run_id,request_id,fetch_attempt_id,request_method,request_url,request_headers_json,representation_fingerprint,response_vary_json,retrieved_at,http_status,response_headers_json,content_digest,content_byte_length,content_object_key,source_lineage,supported_game,game_profile_version,adapter_version) VALUES (?,?,'unused',?,'GET','https://source.invalid/unused','{}','fixture','[]','2026-01-01T00:00:00.000Z',200,'{}',?,?,?,'digimon-en','digimon',?,?)`).bind(id,run,id,await sha256Text(body),new TextEncoder().encode(body).length,key,adapter.game_profile_version,adapter.adapter_version),
   ]);
   await env.EVIDENCE_OBJECTS.put(key,body);
   return Response.json({run,id,key});
  }
  // Test-only clock override is scoped to this synthetic cleanup request.
  // The production configuration retains its system-owned clock.
  if (new URL(request.url).pathname.startsWith('/v1/evidence-cleanups/') && request.headers.has('x-keepr-test-now')) {
   const clockEnv = new Proxy(env, { get(target, property) { return property === 'ADMINISTRATION_CLOCK_MODE' ? 'request' : Reflect.get(target, property); } });
   return ingestion.fetch(request,clockEnv,ctx);
  }
  return ingestion.fetch(request,env,ctx);
 }
};
