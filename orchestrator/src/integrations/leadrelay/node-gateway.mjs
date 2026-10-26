/** LeadRelay control bridge for an existing authenticated Node.js HQ.
 * Server-only. No default authentication, automatic deployment or open proxy.
 * Node 20+; no package dependencies. Supply existing auth, tenant grants and CSRF.
 */
import { isIP } from 'node:net';
export const MAX_BYTES = 800_000;
const OPERATIONS = Object.freeze({
  'GET:status':'status','GET:manifest':'manifest','GET:settings':'settings','GET:providers':'providers',
  'POST:pause':'pause','POST:resume-simulation':'resume-simulation',
  'PUT:settings':'settings','PUT:provider':'provider',
  'POST:pack-export':'business-pack/export','POST:pack-import':'business-pack/import',
  'GET:agent-status':'/api/agent-builder',
  'POST:agent-scan':'/api/agent-builder/scan',
  'POST:agent-approve':'/api/agent-builder/approve',
  'POST:agent-publish':'/api/agent-builder/publish',
  'POST:agent-chat':'/api/agent-builder/chat',
  'POST:agent-test-call':'/api/agent-builder/test-call',
  'POST:agent-deploy':'/api/agent-builder/deploy'
});
export const READ_ACTIONS = Object.freeze(Object.keys(OPERATIONS).filter(k=>k.startsWith('GET:')));
export const ALL_ACTIONS = Object.freeze(Object.keys(OPERATIONS));
export class GatewayError extends Error { constructor(status,detail){super(detail);this.status=status;} }
const deny=(status,detail)=>{throw new GatewayError(status,detail);};

export function loadInstallations(raw, env=process.env) {
  const rows=JSON.parse(raw ?? env.LEADRELAY_INSTALLATIONS_JSON ?? '[]');
  if(!Array.isArray(rows)||rows.length>50) throw new Error('Expected a bounded installation registry');
  const result=new Map();
  for(const row of rows){
    if(!row||Object.keys(row).sort().join(',')!=='base_url,id,key_env,label') throw new Error('Invalid registry fields');
    if(!/^[a-z0-9][a-z0-9-]{0,47}$/.test(row.id)||result.has(row.id)) throw new Error('Invalid/duplicate installation ID');
    if(typeof row.label!=='string'||!row.label.trim()||row.label.length>120) throw new Error('Invalid installation label');
    if(!/^[A-Z][A-Z0-9_]{1,79}$/.test(row.key_env)) throw new Error('Invalid secret environment variable');
    const u=new URL(row.base_url);
    if(u.protocol!=='https:'||u.username||u.password||!['','/'].includes(u.pathname)||u.search||u.hash||u.port||isIP(u.hostname)||u.hostname.includes(':')||!u.hostname.includes('.')||/\.(local|internal|localhost)$/.test(u.hostname)) throw new Error('Use a trusted public HTTPS origin only');
    const key=env[row.key_env];
    if(typeof key!=='string'||key.length<40||/[\r\n]/.test(key)) throw new Error('Missing scoped server key');
    result.set(row.id,Object.freeze({id:row.id,label:row.label,origin:u.origin,key}));
  }
  return result;
}

async function boundedResponse(response){
  const parts=[];let length=0;
  if(response.body){
    const reader=response.body.getReader();
    try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>MAX_BYTES){await reader.cancel();deny(502,'LeadRelay response exceeds limit');}parts.push(Buffer.from(value));}}
    finally{reader.releaseLock();}
  }
  return Buffer.concat(parts).toString('utf8');
}
export async function sendControl(installation,method,path,body,fetchImpl=fetch){
  // The operation table is the complete routing authority. No caller/body/header
  // may supply an upstream origin, path, query, credential or method override.
  if (!Object.entries(OPERATIONS).some(([action,target]) => action.startsWith(method+':') && target === path)) deny(404,'Control operation not found');
  const upstreamPath = path.startsWith('/api/agent-builder') ? path : '/api/control/'+path;
  const payload=body===undefined?undefined:JSON.stringify(body);
  if(payload&&Buffer.byteLength(payload)>MAX_BYTES) deny(413,'Request exceeds limit');
  try{
    const r=await fetchImpl(installation.origin+upstreamPath,{method,
      headers:{authorization:'Bearer '+installation.key,'content-type':'application/json',accept:'application/json'},
      body:payload,redirect:'error',signal:AbortSignal.timeout(path === '/api/agent-builder/chat' ? 15_000 : 10_000)});
    if(!r.ok){
      await r.body?.cancel();
      const allowed=[401,403,409,422,429];
      deny(allowed.includes(r.status)?r.status:502,'LeadRelay rejected this control request; check connection and permissions');
    }
    if(!(r.headers.get('content-type')||'').startsWith('application/json')){await r.body?.cancel();deny(502,'Unexpected LeadRelay response type');}
    const data=JSON.parse(await boundedResponse(r));
    // Never forward any upstream headers/cookies, raw error bodies or credentials.
    return data;
  }catch(e){if(e instanceof GatewayError)throw e;deny(502,'LeadRelay unavailable; no automatic retry was attempted');}
}

function grantsFor(identity, entries, authorize){
  if(!identity || typeof identity.userId!=='string'||typeof identity.workspaceId!=='string')deny(401,'Sign in to Growth HQ');
  return Promise.all([...entries.values()].map(async item=>{
    const actions=await authorize(identity,item.id);
    if(!Array.isArray(actions))throw new Error('Authorizer must return explicit actions');
    if(actions.some(a=>!ALL_ACTIONS.includes(a)))throw new Error('Unknown authorisation action');
    return {item,actions:[...new Set(actions)]};
  })).then(rows=>rows.filter(r=>r.actions.length));
}
export function createDispatcher({installations,authorize,verifyCsrf,transport=sendControl}){
  if(!(installations instanceof Map)||typeof authorize!=='function'||typeof verifyCsrf!=='function')throw new Error('Registry, tenant authorizer and CSRF verifier are required');
  return async({identity,method='GET',path,body,request})=>{
    const grants=await grantsFor(identity,installations,authorize);
    if(path==='/installations'&&method==='GET')return grants.map(({item,actions})=>({id:item.id,label:item.label,actions}));
    const match=/^\/installations\/([a-z0-9][a-z0-9-]{0,47})\/([a-z-]+)$/.exec(path||'');
    if(!match)deny(404,'Control route not found');
    const action=method+':'+match[2];if(!Object.hasOwn(OPERATIONS,action))deny(404,'Control operation not found');
    const grant=grants.find(g=>g.item.id===match[1]);if(!grant)deny(404,'Installation not found');
    if(!grant.actions.includes(action))deny(403,'Your HQ role does not permit this action');
    if(method!=='GET'){
      if(!(await verifyCsrf(identity,request)))deny(403,'Invalid HQ CSRF token');
      if(!body||typeof body!=='object'||Array.isArray(body))deny(400,'Expected a JSON object');
      if(Buffer.byteLength(JSON.stringify(body))>MAX_BYTES)deny(413,'Request exceeds limit');
      if(match[2].startsWith('agent-') && ['installationId','workspaceId','userId','base_url','key','key_env','secret','provider_key','to_number','phone','own_phone','recipient'].some(key => Object.hasOwn(body,key))) deny(400,'Agent authority, credentials and call destination are server-controlled');
    }
    return transport(grant.item,method,OPERATIONS[action],body);
  };
}

/** Mount on the existing Node HTTP router. Returns false for unrelated paths.
 * authenticate must use the existing server session; never trust browser IDs.
 * Keep existing rate limits/security headers before invoking this handler.
 */
export function createNodeHandler({authenticate,apiBase='/api/leadrelay',...options}){
  if(typeof authenticate!=='function'||!/^\/[a-zA-Z0-9/_-]+$/.test(apiBase)||apiBase.startsWith('//'))throw new Error('Existing authentication and a same-origin path are required');
  const dispatch=createDispatcher(options);
  return async(req,res)=>{
    const path=new URL(req.url||'/', 'https://hq.invalid').pathname;
    if(path!==apiBase&&!path.startsWith(apiBase+'/'))return false;
    let code=200,data;
    try{
      const identity=await authenticate(req);if(!identity)deny(401,'Sign in to Growth HQ');
      let body;
      if(req.method!=='GET'){
        if(!(req.headers['content-type']||'').startsWith('application/json'))deny(415,'Use application/json');
        let total=0;const chunks=[];
        for await(const chunk of req){const b=Buffer.from(chunk);total+=b.length;if(total>MAX_BYTES)deny(413,'Request exceeds limit');chunks.push(b);}
        try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{deny(400,'Invalid JSON');}
      }
      data=await dispatch({identity,method:req.method,path:path.slice(apiBase.length),body,request:req});
    }catch(e){code=e instanceof GatewayError?e.status:500;data={detail:e instanceof GatewayError?e.message:'HQ control configuration error'};}
    res.writeHead(code,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
    res.end(JSON.stringify(data));return true;
  };
}
