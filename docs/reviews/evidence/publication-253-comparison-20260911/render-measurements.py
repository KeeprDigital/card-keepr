from pathlib import Path
import json
base=Path(__file__).resolve().parent
s=json.loads((base/'summary.json').read_text());runs=s['measurements'];out=[]
def add(x=''):out.append(x)
def table(head,rows):
 add('| '+' | '.join(head)+' |');add('| '+' | '.join(['---']*len(head))+' |')
 for row in rows:add('| '+' | '.join(map(str,row))+' |')
 add()
def label(r):return r['variant']+' '+('U' if r['pair']=='unchanged' else 'C')+'/'+r['scenario']
def ex(r,k):return r['phases'].get(k,{}).get('exclusive_seconds',0)
def inc(r,k):return r['phases'].get(k,{}).get('inclusive_seconds',0)
def requests(r,m):return sum(v for k,v in r['r2'].items() if k.endswith('.'+m))
def mb(n):return f'{n/1e6:.3f}'
def f(n):return f'{n:,.0f}'
add('# Retained publication comparison measurements');add()
add('11 September 2026. Derived from [summary.json](summary.json) and the raw reports/logs listed in [README.md](README.md). `single` is the current public format; `grouped` is the isolated alternative. U is the full→unchanged history; C is the independent full→changed history. Every row retains the original 1,001 Products and 4,006 public records. MB is decimal. These are emulator measurements, not production performance or billing.');add()
add('## Phase time');add()
add('Seconds. Candidate includes collection, candidate construction, native callbacks and inspection. Private and public are disjoint callback intervals. Switch/orchestration is the remaining publication driver time, including its status/control work; it is **not** isolated atomic SQL commit latency. Backup is inclusive of its detailed phases below. Consumer includes the original assertions plus the extra complete catalogue pass. Other is the residual measured journey time. The inclusive publication+backup interval is in the JSON and must not be added to these columns.');add()
rows=[]
for r in runs:
 candidate=sum(ex(r,k) for k in ('collection','candidate','candidate-workflow','inspection'))
 private=ex(r,'private');public=ex(r,'public');backup=inc(r,'backup');orchestration=ex(r,'publication-inclusive')+ex(r,'workflow-other');consumer=ex(r,'original-consumer-checks')+ex(r,'complete-consumer-verification')
 vals=[candidate,private,public,orchestration,backup,consumer,r['elapsed_seconds']-sum((candidate,private,public,orchestration,backup,consumer)),r['elapsed_seconds']]
 rows.append([label(r)]+[f'{x:.3f}' for x in vals])
table(['Run','Candidate','Private','Public','Switch/orchestration','Backup incl.','Consumer','Other','Total'],rows)
add('## Storage requests, database work and bytes read');add()
add('Totals cover the measured journey, including verification and its intentionally repeated consumer passes. D1 calls count binding entries; a batch call can contain many statements. SQL statements count every submitted statement within a batch. Rows are returned emulator metadata, not independently audited index operations. The separate host restore database is reported below. Object census/migrations are outside this interval. Zero application LIST/DELETE requests were observed; inventory LIST requests are excluded. PUT outcomes are a subdivision of PUT attempts and must not be added to them.');add()
table(['Run','GET','HEAD','PUT attempts','PUT acknowledged','Conditional reuse','D1 calls','D1 statements','Rows read','Rows written'],[[label(r),f(requests(r,'get')),f(requests(r,'head')),f(requests(r,'put')),f(requests(r,'put_success')),f(requests(r,'conditional_reuse')),f(sum(v for k,v in r['calls'].items() if k.startswith('D1.'))),f(r['d1_statements']),f(r['rows_read']),f(r['rows_written'])] for r in runs])
rows=[]
for r in runs:
 path=base/f"{r['variant']}-final.json.{r['pair']}"
 import gzip
 d=json.loads(path.read_text() if path.exists() else gzip.open(str(path)+'.gz','rt').read())
 raw=next(p for p in d['reports'] if p['scenario']==r['scenario'])
 p=raw['phases'];consumer=r['phases']['complete-consumer-verification']
 rows.append([label(r),mb(sum(v.get('get_object_bytes',0) for v in p.values())),mb(sum(v.get('head_declared_bytes',0) for v in p.values())),f(consumer['calls'].get('CATALOGUE_EXPORTS.get',0)),f(consumer['d1_statements']),mb(r['compressed_bytes']),mb(r['incremental_download_bytes'])])
table(['Run','GET object-body sizes MB','HEAD declared sizes MB','One full consumer GETs','One full consumer SQL statements','Full compressed MB','Changed-object download MB'],rows)
add('GET object sizes are returned body-object sizes, not a wire capture or proof every returned stream was consumed. HEAD values describe existing objects and are not transferred bodies. Consumer bytes are actually read/hashed/decompressed. Changed-object bytes assume a consumer retains predecessor component bodies; manifests/metadata and HTTP overhead are not included. All HTTP paths and provider calls are retained in the JSON; the export/import API control plane is simulated while its SQL content/export/import is real.');add()
add('## Files and retained state');add()
add('New/reused component counts are relative to the immediate predecessor, not a claim that every absent digest has never existed historically. Physical storage is separately counted by successful PUTs and retained inventory. Private objects below are the full `publication-artifacts` class, including composition/export nodes. Backups include SQL plus small backup metadata. Retention is a snapshot after each journey, not byte-months. No cleanup/expiry is simulated.');add()
rows=[]
for r in runs:
 b=r['retained_buckets'];p=b['CATALOGUE_EXPORTS']['publication-artifacts'];pub=b['CATALOGUE_EXPORTS']['catalogue-public-components'];source=sum(x['bytes'] for x in b['EVIDENCE_OBJECTS'].values())
 rows.append([label(r),f(r['components']),f(r['created_components']),f(r['reused_components']),f(pub['objects']),mb(pub['bytes']),f(p['objects']),mb(p['bytes']),mb(source),mb(r['database_bytes']),mb(r['retained_backup_bytes'])])
table(['Run','Current files','New','Reused','Retained public files','Public MB','Private-class files','Private MB','Evidence MB','D1 MB','Backup MB'],rows)
add('All source observations/snapshots, manifest bytes and per-table row inventories are available in the JSON. The first full singleton/grouped publication has 13,701/13,532 private-class objects. Every no-change acceptance adds 2,264 more despite creating zero public component objects. D1 per-table byte attribution was not available; row counts alone cannot assign the database growth to individual tables.');add()
add('## Backup, actual SQL import and restored verification');add()
rows=[]
for variant in ('single','grouped'):
 selected=[r for r in runs if r['variant']==variant]
 for r,export,restore in zip(selected,s['sql'][variant]['exports'],s['sql'][variant]['imports']):
  rows.append([label(r)]+[f'{ex(r,k):.3f}' for k in ('backup.snapshot','backup.artifacts','backup.sql-export','backup.target','backup.sql-import','backup.restored-verification','backup')]+[mb(export['bytes']),f(export['statements']),f"{restore['ms']/1000:.3f}",mb(restore['pages']['page_count']*restore['page_size']['page_size'])])
table(['Run','Snapshot s','Artifacts s','SQL export s','Target s','SQL import phase s','Restored verify s','Other backup s','SQL MB','Dump statements','Host import s','Restored DB MB'],rows)
add('The SQL import phase includes upload/provider coordination; host import is nested inside it, not additional time. Every import above had zero foreign-key errors and passed the production restored-content proof. Across four checkpoints, singleton restored verification issued 5,707 real SQLite query calls returning 571,924 rows; grouped issued 5,415 returning 534,705 rows. Those host queries and SQL dump statements are separate from wrapped application D1 totals. Raw query logs allow attribution by checkpoint.');add()
add('## Callback and interruption work');add()
table(['Run','Native candidate callbacks','Private callbacks','Public callbacks'],[[label(r)]+[f(r['callbacks'].get(k,{}).get('count',0)) for k in ('candidate-workflow','private','public')] for r in runs])
add('Callbacks are controlled driver executions of production functions, not billed Workflow steps or CPU. The repeated native candidate scenario uses predecessor/history work; it is distinct from the original fresh-candidate 15-second assertion. Callback `max_calls` in the raw report excludes nested backup phase counters and cannot certify the entire backup callback guard.');add()
rows=[]
for variant,d in s['interruption'].items():
 for phase,p in d['phases'].items():
  c=p['calls'];rows.append([variant,phase.removeprefix('interruption.'),p['ms'],p['statements'],p['rows_read'],p['rows_written'],c.get('CATALOGUE_EXPORTS.put',0),c.get('CATALOGUE_EXPORTS.put_success',0),c.get('CATALOGUE_EXPORTS.conditional_reuse',0),c.get('CATALOGUE_EXPORTS.get',0),c.get('CATALOGUE_EXPORTS.head',0)])
table(['Layout','Unit','ms','SQL statements','Rows read','Rows written','PUT','PUT success','Conditional reuse','GET','HEAD'],rows)
add('The 64-Product probe loses a successful public PUT response before the unit receipt/cursor commits, retries that same unit, then repeats its committed result. Both completed with exact semantic replay, full consumer verification and real backup/restore. The grouped fixture has groups of up to three records overall, but its first interrupted group is not a maximum-size-group proof. No claim of platform termination, all-phase recovery, or reduced worst-case retry work follows from this one fault point.');add()
add('## Host memory and measurement limits');add()
table(['Layout process','Whole process elapsed s','Peak process-tree RSS GiB','Peak workerd-process RSS GiB','1-second samples'],[[v,f"{d['wall_seconds']:.3f}",f"{d['process_tree_peak_rss_KiB']/1048576:.3f}",f"{d['workerd_processes_peak_rss_KiB']/1048576:.3f}",d['samples']] for v,d in s['process_measurements'].items()])
add('Whole process time includes two independent histories, setup, census and cleanup. Sampled RSS is a sum across descendant processes and may share pages; it includes retained local storage, SQL transport and complete-catalogue test buffers. It cannot measure production isolate peak working set, active CPU, platform network latency, retained Workflow state pricing or a bill. There are no production measurements in this experiment.');add()
(base/'measurements.md').write_text('\n'.join(out)+'\n')
