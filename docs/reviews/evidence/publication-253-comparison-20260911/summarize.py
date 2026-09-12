"""Derive comparison from retained real-runtime outputs; no production mutations."""
from pathlib import Path
import json,gzip,hashlib,re
base=Path(__file__).resolve().parent
def read_text(path):
 if path.exists():return path.read_text()
 with gzip.open(str(path)+'.gz','rt') as f:return f.read()
runs={}
for variant in ('single','grouped'):
 for pair in ('unchanged','changed'):
  path=base/f'{variant}-final.json.{pair}'
  d=json.loads(read_text(path));catalogues=json.load(gzip.open(str(path)+'.catalogues.json.gz'))
  for report,catalogue in zip(d['reports'],catalogues):
   runs[(variant,pair,report['scenario'])]=(report,catalogue['records'])
summary=[]
for key,(r,records) in runs.items():
 counts={}; phases={}
 for name,p in r['phases'].items():
  phases[name]={'inclusive_seconds':p['ms']/1000,'exclusive_seconds':max(0,p['ms']-p['child_ms'])/1000,'d1_statements':p['statements'],'rows_read':p['rows_read'],'rows_written':p['rows_written'],'calls':p['calls']}
  for method,n in p['calls'].items():counts[method]=counts.get(method,0)+n
 r2={m:n for m,n in counts.items() if m.startswith(('CATALOGUE_EXPORTS.','EVIDENCE_OBJECTS.','PRINTING_IMAGES.','BACKUPS.'))}
 inventory=r['inventory'];public=r['components']
 backup_bytes=sum(v['bytes'] for v in inventory['buckets']['BACKUPS'].values())
 summary.append({'variant':key[0],'pair':key[1],'scenario':key[2],'elapsed_seconds':r['elapsed_ms']/1000,'publication_and_backup_seconds':r['phases']['publication-inclusive']['ms']/1000,'phases':phases,'calls':counts,'r2':r2,'d1_statements':sum(p['statements'] for p in r['phases'].values()),'rows_read':sum(p['rows_read'] for p in r['phases'].values()),'rows_written':sum(p['rows_written'] for p in r['phases'].values()),'record_count':r['record_count'],'content_sha256':r['content_sha256'],'components':len(public),'created_components':r['created_components'],'reused_components':r['reused_components'],'compressed_bytes':r['consumer_compressed_bytes'],'raw_bytes':r['consumer_raw_bytes'],'incremental_download_bytes':r['incremental_download_bytes'],'max_group_records':max(c['records'] for c in public),'max_group_raw_bytes':max(c['uncompressed_bytes'] for c in public),'database_bytes':inventory['emulator_database_size'],'retained_backup_bytes':backup_bytes,'retained_buckets':inventory['buckets'],'table_rows':inventory['rows'],'callbacks':r['callbacks'],'completed':r.get('completed',False)})
comparisons=[]
def identity(r):return (r['type'],r.get('id',r.get('profile',r.get('game',''))))
for pair in ('unchanged','changed'):
 for scenario in ('full',pair):
  a,ar=runs['single',pair,scenario];b,br=runs['grouped',pair,scenario]
  assert ar==br, (pair,scenario,'catalogue mismatch')
  assert a['content_sha256']==b['content_sha256']
  assert len(ar)==4006 and a['completed'] and b['completed']
  a_ids={v for c in a['components'] for v in c['ids'] if v is not None};b_ids={v for c in b['components'] for v in c['ids'] if v is not None}
  assert a_ids==b_ids, 'Generated raw identifiers differ'
  comparisons.append({'pair':pair,'scenario':scenario,'equal_complete_catalogue':True,'equal_raw_entity_identifiers':True,'content_sha256':a['content_sha256']})
for variant in ('single','grouped'):
 before={identity(r):r for r in runs[variant,'changed','full'][1]};after={identity(r):r for r in runs[variant,'changed','changed'][1]}
 assert before.keys()==after.keys()
 changed=[k for k in before if before[k]!=after[k]]
 factual=[k for k in before if {p:v for p,v in before[k].items() if p!='lifecycle'}!={p:v for p,v in after[k].items() if p!='lifecycle'}]
 assert len(factual)==1 and factual[0]==('card','CARD:one-piece:card_number:OP21-0001')
 comparisons.append({'variant':variant,'source_card_name_changes':1,'public_records_changed':len(changed),'factual_records_changed':len(factual),'lifecycle_only_records_changed':len(changed)-len(factual)})
# Read the production group's actual membership; analyze, do not claim, an insertion publication.
r= runs['grouped','unchanged','full'][0]
components=[c for c in r['components'] if c['kind']=='products']
ids=sorted(v for c in components for v in c['ids'])
def group(values):
 ranges={}
 for value in sorted(values):ranges.setdefault(re.search(r'_([a-f0-9]{2})[a-f0-9]+$',value).group(1),[]).append(value)
 return [tuple(members[i:i+4]) for members in ranges.values() for i in range(0,len(members),4)]
actual={tuple(c['ids']) for c in components};assert actual==set(group(ids)), 'Insertion model does not match measured Product groups'
bucket=re.search(r'_([a-f0-9]{2})[a-f0-9]+$',ids[0]).group(1);insert='product_'+bucket+'0'*62
assert insert not in ids
before=set(group(ids));after=set(group(ids+[insert]));unchanged=before&after
insertion={'kind':'analytical membership probe from actual groups, not a publication or restore','new_id':insert,'group_count_before':len(before),'group_count_after':len(after),'unchanged_groups':len(unchanged),'replaced_old_groups':len(before-after),'new_groups':len(after-before),'affected_identity_range':bucket}
# Precise cross-range check.
assert {c for c in before if not c[0].startswith('product_'+bucket)}=={c for c in after if not c[0].startswith('product_'+bucket)}
insertion['other_ranges_unchanged']=True
faults={}
for variant in ('single','grouped'):
 d=json.loads((base/f'{variant}-fault.json').read_text());assert d['completed'] and d['replayed_equal'] and d['fault_applied'];faults[variant]={k:v for k,v in d.items() if k!='phases'};faults[variant]['phases']={k:v for k,v in d['phases'].items() if k.startswith('interruption.')}
processes={variant:json.loads((base/f'{variant}-final-process.json').read_text()) for variant in ('single','grouped')}
sql={}
for variant in ('single','grouped'):
 log=read_text(base/f'{variant}-final.log');sql[variant]={'exports':[json.loads(x) for x in re.findall(r'EXPERIMENT_SQL_EXPORT (\{[^\n]+\})',log)],'imports':[json.loads(x) for x in re.findall(r'EXPERIMENT_SQL_IMPORT (\{[^\n]+\})',log)],'restore_query_count':len(re.findall('EXPERIMENT_RESTORE_QUERY',log)),'returned_restore_rows':sum(json.loads(x)['returned_rows'] for x in re.findall(r'EXPERIMENT_RESTORE_QUERY (\{[^\n]+\})',log))}
 assert len(sql[variant]['imports'])==4 and all(i['foreign_key_errors']==0 for i in sql[variant]['imports'])
output={'contract':'publication-253-comparison-summary@1','measurements':summary,'equivalence':comparisons,'insertion_analysis':insertion,'interruption':faults,'process_measurements':processes,'sql':sql}
(base/'summary.json').write_text(json.dumps(output,indent=2)+'\n')
print('Verified all paired catalogues, raw identifiers, four restores per variant, and both interruption probes.')
for r in summary:
 print(r['variant'],r['pair'],r['scenario'],'elapsed',r['elapsed_seconds'],'publication+backup',r['publication_and_backup_seconds'],'components',r['components'],'new',r['created_components'],'reused',r['reused_components'],'GET',sum(v for k,v in r['r2'].items() if k.endswith('.get')),'D1 statements',r['d1_statements'],'DB',r['database_bytes'])
print(json.dumps(insertion))
