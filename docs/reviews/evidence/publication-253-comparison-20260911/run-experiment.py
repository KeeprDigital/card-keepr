import os,subprocess,time,json,sys,signal
from pathlib import Path
# Portable path inputs added after the measurements; sampling/measurement loop retained.
variant=sys.argv[1];work=Path(os.environ['PUBLICATION_EXPERIMENT_WORKTREE']);e=Path(os.environ['PUBLICATION_EXPERIMENT_EVIDENCE']);e.mkdir(parents=True,exist_ok=True)
if (e/(variant+'.log')).exists():raise SystemExit('Choose a fresh output label; refusing to overwrite evidence')
env=dict(os.environ,KEEPR_TEST_SUITE='stress',PUBLICATION_EXPERIMENT_OUTPUT=str(e/(variant+'.json')))
command=['pnpm','exec','vitest','run','--config','apps/ingestion/vitest.config.ts',(sys.argv[2] if len(sys.argv)>2 else 'apps/ingestion/test/publication-layout-experiment.stress.spec.ts'),'--reporter=default','--reporter=./test/support/publication-experiment-reporter.mjs']
log=open(e/(variant+'.log'),'w');started=time.monotonic();p=subprocess.Popen(command,cwd=work,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
peak=0;workerdPeak=0;samples=0;last=0
while p.poll() is None:
 now=time.monotonic();rows=subprocess.check_output(['ps','-axo','pid=,ppid=,rss=,comm='],text=True).splitlines();processes=[]
 for row in rows:
  parts=row.strip().split(None,3)
  if len(parts)==4:processes.append((int(parts[0]),int(parts[1]),int(parts[2]),parts[3]))
 ids={p.pid}
 while True:
  more={pid for pid,ppid,rss,comm in processes if ppid in ids}
  if more<=ids:break
  ids|=more
 rss=sum(rss for pid,ppid,rss,comm in processes if pid in ids);wrss=sum(rss for pid,ppid,rss,comm in processes if pid in ids and 'workerd' in comm)
 peak=max(peak,rss);workerdPeak=max(workerdPeak,wrss);samples+=1
 if now-started>1200:os.killpg(p.pid,signal.SIGTERM);time.sleep(3);os.killpg(p.pid,signal.SIGKILL);break
 if now-last>30: print(json.dumps({'variant':variant,'elapsed_s':round(now-started),'process_tree_rss_KiB':rss}),flush=True);last=now
 time.sleep(1)
rc=p.wait();log.close();result={'variant':variant,'exit_code':rc,'wall_seconds':time.monotonic()-started,'process_tree_peak_rss_KiB':peak,'workerd_processes_peak_rss_KiB':workerdPeak,'samples':samples,'note':'sampled process RSS, not isolate working set; no production CPU/billing'};(e/(variant+'-process.json')).write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result));sys.exit(rc)
