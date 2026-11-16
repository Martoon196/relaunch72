#!/bin/sh
# Explicit benchmark only. Downloaded film and rendered output are never published.
set -eu
mkdir -p /tmp/rl72-render-evidence
curl -fL --max-time 180 --output /tmp/rl72-render-evidence/tears-of-steel-1080p.zip https://download.blender.org/demo/movies/ToS/tears_of_steel_1080p.mov.zip
python3 - <<'PY'
import zipfile,shutil,hashlib,json
from pathlib import Path
root=Path('/tmp/rl72-render-evidence');archive=root/'tears-of-steel-1080p.zip'
h=hashlib.sha256()
with archive.open('rb') as f:
 for chunk in iter(lambda:f.read(1048576),b''):h.update(chunk)
with zipfile.ZipFile(archive) as z:
 with z.open('tears_of_steel_1080p.mov') as source,(root/'tears-of-steel-hd.mov').open('wb') as out:shutil.copyfileobj(source,out)
(root/'download-receipt.json').write_text(json.dumps({'url':'https://download.blender.org/demo/movies/ToS/tears_of_steel_1080p.mov.zip','archiveSha256':h.hexdigest(),'credit':'(CC) Blender Foundation / mango.blender.org — Tears of Steel (2012)','licence':'https://creativecommons.org/licenses/by/3.0/','sourceTerms':'https://mango.blender.org/about/','purpose':'private technical benchmark; no film/export distribution'},indent=2))
PY
ffmpeg -hide_banner -loglevel error -nostdin -ss 60 -i /tmp/rl72-render-evidence/tears-of-steel-hd.mov -t 180 -vf pad=1920:1080:0:140 -c:v libx264 -preset medium -crf 23 -threads 1 -c:a aac -b:a 96k -movflags +faststart -y /tmp/rl72-render-evidence/real-live-action-180s-1080p.mp4
ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=width,height,nb_read_frames,avg_frame_rate -of json /tmp/rl72-render-evidence/real-live-action-180s-1080p.mp4 > /tmp/rl72-render-evidence/real-frames.json
node_modules/.bin/esbuild orchestrator/test/tools/media-memory-render.ts --bundle --platform=node --format=cjs --outfile=/tmp/rl72-render-evidence/render.cjs
RL72_MEDIA_MEMORY_SOURCE=/tmp/rl72-render-evidence/real-live-action-180s-1080p.mp4 RL72_MEDIA_MEMORY_INPUT_DESCRIPTION='Tears of Steel (Blender CC-BY 3.0), continuous original 60-240 seconds; 1920x800 picture letterboxed to 1920x1080, 24 fps, AAC audio. No upscale, looping or byte padding.' python3 orchestrator/test/tools/media-memory-measure.py
python3 - <<'PY'
import json
from pathlib import Path
r=Path('/tmp/rl72-render-evidence');m=json.loads((r/'measurement.json').read_text());frames=json.loads((r/'real-frames.json').read_text())['streams'][0]
assert frames['width']==1920 and frames['height']==1080 and int(frames['nb_read_frames'])>=4320
assert m['exitCode']==0 and not m['aggregateLimitKilled'] and m['aggregatePeakRssKiB']<1572864
m['download']=json.loads((r/'download-receipt.json').read_text());m['decodedFrames']=frames
(r/'live-action-measurement.json').write_text(json.dumps(m,indent=2));print(json.dumps(m,indent=2))
PY
