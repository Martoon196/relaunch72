import subprocess,os,time,json,signal
p=subprocess.Popen(['prlimit','--as=1610612736','--','node','--jitless','--max-old-space-size=128','/tmp/rl72-render-evidence/render.cjs'],stdout=open('/tmp/rl72-render-evidence/result.log','w'),stderr=subprocess.STDOUT,start_new_session=True)
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
result={'exitCode':p.returncode,'aggregateRssWatchdogLimitKiB':1572864,'aggregateLimitKilled':killed,'aggregatePeakRssKiB':peak,'elapsedSeconds':round(time.monotonic()-start,2),'samples':samples,'outerAddressSpaceLimitBytes':1610612736,'ffmpegAddressSpaceLimitBytes':1073741824,'input':'180 seconds moving testsrc2 1920x1080 30fps + real AAC sine; synthetic stress, not camera footage','timeline':'0-90 s plus 90-180 s, landscape, #ad, speed 1'}
open('/tmp/rl72-render-evidence/measurement.json','w').write(json.dumps(result,indent=2));print(result)
