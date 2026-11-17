import subprocess,os,time,json,signal,sys
whole='--whole-command' in sys.argv
os.makedirs('/tmp/rl72-render-evidence',exist_ok=True)
strict=os.environ.get('RL72_MEDIA_MEMORY_STRICT_AS')=='true'
command=['node','--max-old-space-size=128','/tmp/rl72-render-evidence/render.cjs']
if strict:command=['prlimit','--as=1610612736','--','node','--jitless','--max-old-space-size=128','/tmp/rl72-render-evidence/render.cjs']
if whole:command=['sh','orchestrator/test/tools/media-real-footage-memory.sh']
log='/tmp/rl72-render-evidence/whole-command.log' if whole else '/tmp/rl72-render-evidence/result.log'
p=subprocess.Popen(command,stdout=open(log,'w'),stderr=subprocess.STDOUT,start_new_session=True)
peak=0;samples=0;killed=False;start=time.monotonic()
while p.poll() is None:
 ps={}
 for entry in os.scandir('/proc'):
  if not entry.name.isdigit():continue
  try:
   text=open(entry.path+'/status').read();vals={l.split(':')[0]:l.split(':')[1].strip() for l in text.splitlines() if ':' in l};ps[int(entry.name)]=(int(vals.get('PPid','0')),int(vals.get('VmRSS','0 kB').split()[0]))
  except (FileNotFoundError,ProcessLookupError,PermissionError):pass
 ids={p.pid}
 for _ in range(5):ids|={pid for pid,(parent,rss) in ps.items() if parent in ids}
 rss=sum(ps.get(pid,(0,0))[1] for pid in ids);peak=max(peak,rss);samples+=1
 if rss>1572864:killed=True;os.killpg(p.pid,signal.SIGKILL)
 time.sleep(.05)
result={'exitCode':p.returncode,'aggregateRssWatchdogLimitKiB':1572864,'aggregateLimitKilled':killed,'aggregatePeakRssKiB':peak,'elapsedSeconds':round(time.monotonic()-start,2),'samples':samples,'outerAddressSpaceLimitBytes':1610612736 if strict else None,'nodeJitEnabled':not strict,'nodeMaxOldSpaceMiB':128,'ffmpegAddressSpaceLimitBytes':1073741824,'input':os.environ.get('RL72_MEDIA_MEMORY_INPUT_DESCRIPTION','180 seconds moving testsrc2 1920x1080 30fps + AAC sine; synthetic stress'),'timeline':'0-90 s plus 90-180 s, landscape, #ad, speed 1'}
result['scope']='whole download/normalise/bundle/probe/render command' if whole else 'renderer subprocess tree only'
if whole:
 result['input']='Tears of Steel: continuous original seconds 60–240, 1920x800 picture letterboxed to 1920x1080; includes preparation and rendering'
 result['command']=['sh','orchestrator/test/tools/media-real-footage-memory.sh']
 for key in ['nodeJitEnabled','nodeMaxOldSpaceMiB','ffmpegAddressSpaceLimitBytes','outerAddressSpaceLimitBytes']:result.pop(key,None)
 result['rendererOnly']=json.load(open('/tmp/rl72-render-evidence/measurement.json')) if os.path.exists('/tmp/rl72-render-evidence/measurement.json') else None
else:result['rendererReceipts']=[json.loads(line) for line in open(log) if line.startswith('{')]
path='/tmp/rl72-render-evidence/whole-command-memory.json' if whole else '/tmp/rl72-render-evidence/measurement.json'
open(path,'w').write(json.dumps(result,indent=2));print(json.dumps(result,indent=2))
if result['exitCode'] or killed:raise SystemExit(1)
