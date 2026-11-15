/**
 * Authenticated RL72 Media API. Both /portal/studio and /studio share this API.
 * Caller resolves tenantId from the signed portal cookie; never from request JSON.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import { MediaEngine } from './engine.js';
import { MediaError } from './store.js';

export function publicAffiliatePath(secret: string, tid: string, cid: string, pid: string): string {
  const message = tid + '|' + cid + '|' + pid;
  const signature=crypto.createHmac('sha256',secret).update('affiliate:' + message).digest('hex');
  return '/go/' + encodeURIComponent(tid) + '/' + encodeURIComponent(cid) + '/' + encodeURIComponent(pid) + '/' + signature;
}
/** Public, signed outbound links. No browser may supply an arbitrary destination. */
export async function handleAffiliateRedirect(
  req:IncomingMessage,res:ServerResponse,engine:MediaEngine,secret:string,
):Promise<void> {
  const pathname=new URL(req.url??'/', 'http://localhost').pathname;
  const match=pathname.match(/^\/go\/([a-zA-Z0-9_-]{1,100})\/([a-zA-Z0-9-]{8,100})\/([a-zA-Z0-9-]{8,100})\/([a-f0-9]{64})$/);
  if(req.method!=='GET'||!match){res.writeHead(404);res.end();return;}
  const expected=publicAffiliatePath(secret,match[1]!,match[2]!,match[3]!).split('/').at(-1)!;
  if(!crypto.timingSafeEqual(Buffer.from(match[4]!),Buffer.from(expected))){
    res.writeHead(404);res.end();return;
  }
  try{
    const url=await engine.outboundClick(match[1]!,match[2]!,match[3]!);
    res.writeHead(302,{location:url,'cache-control':'no-store','referrer-policy':'no-referrer',
      'x-content-type-options':'nosniff'});res.end();
  }catch{res.writeHead(404);res.end();}
}
export function mediaCsrf(secret: string, signedSession: string): string {
  return crypto.createHmac('sha256', secret).update('media:' + signedSession).digest('hex');
}
function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff',
    'Content-Length':String(Buffer.byteLength(text)) });
  res.end(text);
}
async function bodyJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let n = 0;
  const parts: Buffer[] = [];
  for await (const part of req) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    n += chunk.length;
    if (n > 250000) throw new MediaError('Request body too large', 413);
    parts.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object');
    return parsed as Record<string, unknown>;
  } catch { throw new MediaError('Invalid JSON request'); }
}
const id = '([a-zA-Z0-9-]{8,100})';

export async function handleMediaApi(
  req: IncomingMessage, res: ServerResponse, engine: MediaEngine,
  tenantId: string, expectedCsrf: string, signingSecret: string,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';
  const p = url.pathname;
  try {
    if (method === 'GET' && p === '/portal/api/media') {
      const data=await engine.list(tenantId);
      const campaigns=data.campaigns.map((c)=>({...c,products:c.products.map((p)=>({
        ...p,trackedPath:p.affiliateUrl?publicAffiliatePath(signingSecret,tenantId,c.id,p.id):null,
      }))}));
      send(res,200,{ capabilities:engine.capabilities(), ...data, campaigns });
      return;
    }
    if (!['POST','PATCH'].includes(method)) throw new MediaError('Not found',404);
    const given = req.headers['x-rl72-csrf'];
    const expected = Buffer.from(expectedCsrf);
    const actual = Buffer.from(typeof given === 'string' ? given : '');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual,expected))
      throw new MediaError('CSRF check failed',403);
    if ((req.headers['content-type']??'').split(';')[0]?.toLowerCase() !== 'application/json')
      throw new MediaError('Expected application/json',415);
    const data = await bodyJson(req);
    const asText = (key:string):string => typeof data[key] === 'string' ? data[key] as string : '';

    if (method === 'POST' && p === '/portal/api/media/campaigns') {
      send(res,201,await engine.create(tenantId, {
        name:asText('name'),brief:asText('brief'),
        mode:data.mode === 'general' ? 'general' : 'affiliate',
        sourceUrl:asText('sourceUrl'), rights:data.rights === 'owned' || data.rights === 'licensed' ? data.rights : 'none',
        rightsEvidence:asText('rightsEvidence'),
      }));
      return;
    }
    let match: RegExpMatchArray | null;
    if (method==='POST' && (match=p.match(new RegExp('^/portal/api/media/campaigns/'+id+'/products$')))) {
      send(res,201,await engine.product(tenantId,match[1]!,{
        name:asText('name'), merchant:asText('merchant'),
        productUrl:asText('productUrl'), affiliateUrl:asText('affiliateUrl'),
      })); return;
    }
    if (method==='POST' && (match=p.match(new RegExp('^/portal/api/media/campaigns/'+id+'/scripts/ai$')))) {
      send(res,201,await engine.draftScript(tenantId,match[1]!)); return;
    }
    if (method==='POST' && (match=p.match(new RegExp('^/portal/api/media/campaigns/'+id+'/variants$')))) {
      send(res,201,await engine.saveScript(tenantId,match[1]!,asText('script'),asText('title')||'Manual draft')); return;
    }
    if (method==='POST' && (match=p.match(new RegExp('^/portal/api/media/campaigns/'+id+'/repurpose$')))) {
      send(res,202,await engine.repurpose(tenantId,match[1]!)); return;
    }
    if (method==='POST' && (match=p.match(new RegExp('^/portal/api/media/campaigns/'+id+'/jobs/'+id+'/poll$')))) {
      send(res,200,await engine.poll(tenantId,match[1]!,match[2]!)); return;
    }
    if (method==='PATCH' && (match=p.match(new RegExp('^/portal/api/media/campaigns/'+id+'/variants/'+id+'$')))) {
      send(res,200,await engine.edit(tenantId,match[1]!,match[2]!,{
        ...(data.title !== undefined ? { title:asText('title') } : {}),
        ...(data.script !== undefined ? { script:asText('script') } : {}),
        ...(data.timeline !== undefined ? { timeline:data.timeline } : {}),
        ...(data.mediaUrl !== undefined ? { mediaUrl:asText('mediaUrl') } : {}),
      }));return;
    }
    if (method==='POST' && (match=p.match(new RegExp('^/portal/api/media/campaigns/'+id+'/variants/'+id+'/approve$')))) {
      send(res,200,await engine.approve(tenantId,match[1]!,match[2]!,{
        claimsVerified:data.claimsVerified===true,
        rightsVerified:data.rightsVerified===true,
        adDisclosure:data.adDisclosure===true,
      }));return;
    }
    if (method==='POST' && (match=p.match(new RegExp('^/portal/api/media/campaigns/'+id+'/variants/'+id+'/render$')))) {
      send(res,202,await engine.render(tenantId,match[1]!,match[2]!));return;
    }
    throw new MediaError('Not found',404);
  }catch(e){
    const status=e instanceof MediaError?e.status:500;
    send(res,status,{error: status===500?'Unexpected media server error':(e as Error).message});
  }
}
