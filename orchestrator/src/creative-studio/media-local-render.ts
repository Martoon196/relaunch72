/**
 * Bounded native FFmpeg render for a previously probed PRIVATE source and
 * owner-saved, immutable timeline. No network, provider API, subscription
 * charge, social publication, CDN URL, or second account system.
 *
 * The worker must first obtain the exact source bytes and plan snapshot from
 * PostgreSQL using a scoped worker lease; this function never treats browser
 * metadata or a guessed rights statement as trusted. Output remains a private
 * candidate until a separate technical probe and owner approval.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SeoBlogError } from '../seo-blog/types.js';
import { checkVideoEditPlan, videoEditDigest, type VideoEditPlan, type VideoCanvas } from './media-edit-plan.js';
import {PrivateMediaFiles,type PrivateMediaObject} from './media-private-files.js';
import {probePrivateMediaFile} from './media-object-sources.js';
import { ffprobeFromBytes, VIDEO_PROBE_VERSION, type VideoProbe } from './media-source-probe.js';

export const LOCAL_RENDER_MAX_BYTES = 20_000_000;
export const LOCAL_RENDER_FFMPEG_VERSION = 'rl72-native-ffmpeg-v1';
export type RenderDimensions = Readonly<{ width: number; height: number }>;
export interface LocalRenderSource {
  readonly bytes: Buffer;
  readonly sha256: string;
  /** Measured independently from the exact source bytes, not the client. */
  readonly probe: VideoProbe;
}
export interface LocalRenderOutput {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly mime: 'video/mp4';
  readonly width: number;
  readonly height: number;
  readonly durationMs: number;
  readonly audioPresent: boolean;
  readonly renderVersion: typeof LOCAL_RENDER_FFMPEG_VERSION;
  readonly planSha256: string;
  readonly sourceSha256: string;
}
export function localRenderDimensions(canvas: VideoCanvas): RenderDimensions {
  if (canvas === 'portrait') return { width: 720, height: 1280 };
  if (canvas === 'square') return { width: 720, height: 720 };
  return { width: 1280, height: 720 };
}
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const safe = (value: string): string => value.replace(/[^a-zA-Z0-9_/.-]/gu, '');
const filterPath = (value: string): string => safe(value).replaceAll(':','\\:');

/** Build an FFmpeg filter graph from a checked, bounded single-source timeline. */
export function localRenderFilterGraph(
  plan: VideoEditPlan, sourceDurationMs: number, audioPresent: boolean,
  captionPaths: readonly string[],
): { graph: string; expectedDurationMs: number; dimensions: RenderDimensions } {
  const p = checkVideoEditPlan(plan);
  if (!Number.isSafeInteger(sourceDurationMs) || sourceDurationMs < 1000
    || sourceDurationMs > 36_000_000 || captionPaths.length !== p.clips.length)
    throw new SeoBlogError(400, 'Measured source and exact caption files required');
  if (p.clips.some(c => c.endMs > sourceDurationMs))
    throw new SeoBlogError(409, 'Saved trim extends beyond the measured source duration');
  const { width, height } = localRenderDimensions(p.canvas);
  const fragments: string[] = [];
  let duration = 0;
  const endpoints: string[] = [];
  for (const [i, clip] of p.clips.entries()) {
    const start = clip.startMs / 1000;
    const end = clip.endMs / 1000;
    const segment = (clip.endMs - clip.startMs) / clip.speed / 1000;
    duration += segment;
    const caption = clip.caption.trim();
    const disclosure = i === 0 ? p.disclosure.trim() : '';
    const title = [caption, disclosure].filter(Boolean).join('  |  ').slice(0, 400);
    let graph = `[0:v:0]trim=start=${start}:end=${end},setpts=(PTS-STARTPTS)/${clip.speed},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p`;
    if (title) {
      const path = captionPaths[i];
      if (!path || !/^[a-zA-Z0-9_/.-]+$/u.test(path))
        throw new SeoBlogError(400, 'Caption file path is not trusted');
      graph += `,drawtext=textfile=${filterPath(path)}:expansion=none:fontcolor=white:fontsize=36:x=(w-text_w)/2:y=h-text_h-64:box=1:boxcolor=black@0.55:boxborderw=12`;
    }
    if (clip.transition === 'fade' && segment >= 0.5) {
      const fade = Math.min(0.25, segment / 4);
      graph += `,fade=t=in:st=0:d=${fade},fade=t=out:st=${Math.max(0, segment-fade).toFixed(3)}:d=${fade}`;
    }
    fragments.push(graph+`[v${i}]`);
    const audio = audioPresent
      ? `[0:a:0]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS,atempo=${clip.speed},volume=${clip.volume??1}[a${i}]`
      : `anullsrc=r=44100:cl=stereo,atrim=duration=${segment},asetpts=PTS-STARTPTS[a${i}]`;
    fragments.push(audio);
    endpoints.push(`[v${i}][a${i}]`);
  }
  fragments.push(endpoints.join('')+`concat=n=${p.clips.length}:v=1:a=1[v][a]`);
  return {
    graph: fragments.join(';'),
    expectedDurationMs: Math.round(duration * 1000),
    dimensions: { width, height },
  };
}

async function runFFmpeg(binary: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false, stderr = '';
    const child = spawn(binary, [...args], {
      shell: false, stdio: ['ignore', 'ignore', 'pipe'],
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new SeoBlogError(504, 'Native render exceeded the safe processing deadline'));
    }, 90_000);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const fail = (e: Error) => finish(e);
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 32_000) {
        child.kill('SIGKILL');
        fail(new SeoBlogError(502, 'Native renderer exceeded diagnostic limits'));
      }
    });
    child.on('error', () => fail(new SeoBlogError(503, 'Native renderer executable is unavailable')));
    child.on('close', code => finish(code === 0 ? undefined :
      new SeoBlogError(502, 'Native renderer failed on the private, checked timeline')));
  });
}

/**
 * ffprobe checks source bytes again inside this worker before FFmpeg touches
 * them. A source with merely an owner-declared licence is never represented
 * as independently copyright-verified.
 */
export async function renderLocalVideo(
  source: LocalRenderSource, plan: VideoEditPlan,
  opts: { ffmpeg?: string; measure?: (bytes: Buffer) => Promise<VideoProbe>;
    render?: (binary: string, args: readonly string[]) => Promise<void> } = {},
): Promise<LocalRenderOutput> {
  if (!Buffer.isBuffer(source.bytes) || source.bytes.length < 1024
    || source.bytes.length > LOCAL_RENDER_MAX_BYTES || sha(source.bytes) !== source.sha256)
    throw new SeoBlogError(409, 'Private video bytes no longer match approved source');
  const measured = source.probe;
  if (measured.status !== 'verified_technical' || measured.checkerVersion !== VIDEO_PROBE_VERSION
    || !Number.isSafeInteger(measured.durationMs) || measured.durationMs! < 1000
    || !Number.isInteger(measured.width) || !Number.isInteger(measured.height)
    || !Number.isFinite(measured.frameRate) || typeof measured.audioPresent !== 'boolean')
    throw new SeoBlogError(409, 'Exact source technical probe required');
  const measure = opts.measure ?? ffprobeFromBytes;
  const fresh = await measure(source.bytes);
  if (fresh.status !== 'verified_technical' || fresh.checkerVersion !== VIDEO_PROBE_VERSION
    || fresh.durationMs !== measured.durationMs
    || fresh.width !== measured.width || fresh.height !== measured.height
    || fresh.videoCodec !== measured.videoCodec || fresh.audioPresent !== measured.audioPresent)
    throw new SeoBlogError(409, 'Fresh source verification disagrees with persisted media probe');
  const checked = checkVideoEditPlan(plan);
  const dir = await mkdtemp(join(tmpdir(), 'rl72-local-render-'));
  try {
    const inputPath = join(dir, 'source.mp4');
    const outputPath = join(dir, 'candidate.mp4');
    await writeFile(inputPath, source.bytes, {flag:'wx',mode:0o600});
    return await renderInputFile(inputPath,dir,source.sha256,checked,measured,measure,opts);
  } finally {
    await rm(dir,{recursive:true,force:true,maxRetries:2});
  }
}

async function renderInputFile(inputPath:string,dir:string,sourceSha256:string,checked:VideoEditPlan,measured:VideoProbe,
 measure:(bytes:Buffer)=>Promise<VideoProbe>,opts:{ffmpeg?:string;render?:(binary:string,args:readonly string[])=>Promise<void>}):Promise<LocalRenderOutput>{
 const outputPath=join(dir,'candidate.mp4');
    const captionFiles: string[] = [];
    for (const [i, clip] of checked.clips.entries()) {
      const path = join(dir,`caption-${i}.txt`);
      const content = [clip.caption.trim(),i === 0 ? checked.disclosure.trim() : ''].filter(Boolean).join('  |  ');
      if (content) await writeFile(path, content, {flag:'wx',mode:0o600});
      captionFiles.push(path);
    }
    const graph = localRenderFilterGraph(checked,measured.durationMs!,measured.audioPresent===true,captionFiles);
    const args = ['-hide_banner','-nostdin','-loglevel','error','-y','-protocol_whitelist','file,pipe','-format_whitelist','mov,matroska,webm','-i',inputPath,
      '-filter_complex',graph.graph,'-map','[v]','-map','[a]',
      '-c:v','libx264','-preset','veryfast','-crf','27','-pix_fmt','yuv420p',
      '-c:a','aac','-b:a','96k','-ac','2',
      '-threads','2','-fs',String(LOCAL_RENDER_MAX_BYTES),
      '-movflags','+faststart',outputPath];
    await (opts.render??runFFmpeg)(opts.ffmpeg??'ffmpeg',args);
    const info = await stat(outputPath);
    if (info.size < 1024 || info.size >= LOCAL_RENDER_MAX_BYTES)
      throw new SeoBlogError(413, 'Native output is incomplete or exceeds private storage capacity');
    const bytes = await readFile(outputPath);
    if (bytes.toString('ascii',4,8)!=='ftyp')
      throw new SeoBlogError(422, 'Native render did not produce a valid MP4 container');
    const outputProbe = await measure(bytes);
    if (outputProbe.status!=='verified_technical' || outputProbe.videoCodec!=='h264'
      || outputProbe.width !== graph.dimensions.width || outputProbe.height !== graph.dimensions.height
      || outputProbe.durationMs === undefined
      || Math.abs(outputProbe.durationMs-graph.expectedDurationMs)>1500)
      throw new SeoBlogError(422, 'Rendered output did not pass an independent technical probe');
    return {
      bytes,sha256:sha(bytes),mime:'video/mp4',
      width:graph.dimensions.width,height:graph.dimensions.height,
      durationMs:outputProbe.durationMs,
      audioPresent:outputProbe.audioPresent===true,
      renderVersion:LOCAL_RENDER_FFMPEG_VERSION,
      planSha256:videoEditDigest(checked),
      sourceSha256:sourceSha256,
    };
}

/** Streaming large-source path; private source bytes never enter a whole-file Buffer. */
export async function renderLocalVideoFile(files:PrivateMediaFiles,object:PrivateMediaObject,probe:VideoProbe,plan:VideoEditPlan):Promise<LocalRenderOutput>{
 const input=await files.verify(object),fresh=await probePrivateMediaFile(input);
 if(fresh.status!=='verified_technical'||probe.status!=='verified_technical'||fresh.checkerVersion!==probe.checkerVersion
  ||fresh.durationMs!==probe.durationMs||fresh.width!==probe.width||fresh.height!==probe.height||fresh.videoCodec!==probe.videoCodec||fresh.audioPresent!==probe.audioPresent)throw new SeoBlogError(409,'Exact independently measured object source required');
 const dir=await mkdtemp(join(tmpdir(),'rl72-object-render-'));
 try{return await renderInputFile(input.path,dir,input.sha256,checkVideoEditPlan(plan),fresh,ffprobeFromBytes,{});}
 finally{await rm(dir,{recursive:true,force:true,maxRetries:2});}
}
