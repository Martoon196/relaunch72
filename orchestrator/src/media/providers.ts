/**
 * Live provider adapters: Vizard clipping and Shotstack rendering.
 * No API keys or vendor credentials are ever returned to browsers.
 * Neither provider is called until a customer deliberately initiates a job.
 */
import { MediaError, validUrl } from './store.js';

interface VizardStart { code?: number; projectId?: number | string; errMsg?: string }
interface VizardClip {
  videoId?: number; videoUrl?: string; title?: string; videoMsDuration?: number; transcript?: string;
}
interface VizardResult { code?: number; errMsg?: string; videos?: VizardClip[] }
interface ShotstackResponse { success?: boolean; response?: { id?: string; status?: string; url?: string; error?: string; credits?: number } }

async function jsonResponse<T>(r: Response): Promise<T> {
  const body = await r.json().catch(() => ({})) as T;
  if (!r.ok) throw new MediaError('Video provider HTTP ' + r.status, 502);
  return body;
}
const VIZARD = 'https://elb-api.vizard.ai/hvizard-server-front/open-api/v1/project';
export class VizardClips {
  constructor(private readonly apiKey = process.env.VIZARD_API_KEY ?? '') {}
  get configured(): boolean { return Boolean(this.apiKey); }
  async start(sourceUrl: string, name: string): Promise<string> {
    if (!this.apiKey) throw new MediaError('Vizard is not configured', 503);
    const u = new URL(validUrl(sourceUrl, 'Source'));
    const isYoutube = ['youtube.com', 'www.youtube.com', 'youtu.be', 'm.youtube.com'].includes(u.hostname);
    const ext = u.pathname.toLowerCase().match(/\.(mp4|mov|m4v|webm)$/)?.[1];
    if (!isYoutube && !ext) throw new MediaError('For now, clipping supports owned YouTube links or direct MP4/MOV/WebM files');
    const data = await jsonResponse<VizardStart>(await fetch(VIZARD + '/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', VIZARDAI_API_KEY: this.apiKey },
      body: JSON.stringify({ lang: 'en', preferLength: [0], videoUrl: sourceUrl,
        videoType: isYoutube ? 2 : 1, ...(!isYoutube ? { ext } : {}), projectName: name,
        subtitleSwitch: 1, maxClipNumber: 12 }),
    }));
    if (data.code !== 2000 || !data.projectId) throw new MediaError('Vizard declined source: ' + (data.errMsg || data.code || 'unknown'), 502);
    return String(data.projectId);
  }
  async check(id: string): Promise<{ status: 'processing' | 'done'; clips: Array<{ title: string; url: string; transcript: string }> }> {
    if (!this.apiKey) throw new MediaError('Vizard is not configured', 503);
    if (!/^[0-9]{1,20}$/.test(id)) throw new MediaError('Invalid Vizard project');
    const data = await jsonResponse<VizardResult>(await fetch(VIZARD + '/query/' + id, { headers: { VIZARDAI_API_KEY: this.apiKey } }));
    if (data.code === 1000) return { status: 'processing', clips: [] };
    if (data.code !== 2000) throw new MediaError('Vizard processing error: ' + (data.errMsg || data.code || 'unknown'), 502);
    return { status: 'done', clips: (data.videos ?? []).filter((v) => !!v.videoUrl)
      .map((v) => ({ title: v.title || 'Suggested clip', url: validUrl(v.videoUrl, 'Clip URL'), transcript: v.transcript || '' })) };
  }
}
export class ShotstackRender {
  constructor(
    private readonly apiKey = process.env.SHOTSTACK_API_KEY ?? '',
    private readonly environment: 'stage' | 'v1' = process.env.SHOTSTACK_ENV === 'v1' ? 'v1' : 'stage',
  ) {}
  get configured(): boolean { return Boolean(this.apiKey); }
  private base(): string { return 'https://api.shotstack.io/edit/' + this.environment + '/render'; }
  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', 'x-api-key': this.apiKey };
  }
  async start(edit: unknown): Promise<string> {
    if (!this.apiKey) throw new MediaError('Shotstack is not configured', 503);
    if (!edit || typeof edit !== 'object' || !('timeline' in edit) || !('output' in edit))
      throw new MediaError('Timeline must be a valid Shotstack Edit JSON with timeline and output');
    const data = await jsonResponse<ShotstackResponse>(await fetch(this.base(), {
      method: 'POST', headers: this.headers(), body: JSON.stringify(edit),
    }));
    if (!data.success || !data.response?.id) throw new MediaError('Shotstack rejected render: ' + (data.response?.error || 'no render ID'), 502);
    return data.response.id;
  }
  async check(id: string): Promise<{ status: 'processing' | 'done' | 'failed'; url: string | null; credits: number | null }> {
    if (!this.apiKey) throw new MediaError('Shotstack is not configured', 503);
    if (!/^[a-zA-Z0-9-]{8,100}$/.test(id)) throw new MediaError('Invalid render ID');
    const data = await jsonResponse<ShotstackResponse>(await fetch(this.base() + '/' + id, { headers: this.headers() }));
    const status = data.response?.status;
    if (status === 'failed') return { status: 'failed', url: null, credits: null };
    if (status === 'done') {
      return { status: 'done', url: data.response?.url ? validUrl(data.response.url, 'Render output') : null,
        credits: typeof data.response?.credits === 'number' ? data.response.credits : null };
    }
    return { status: 'processing', url: null, credits: null };
  }
}
