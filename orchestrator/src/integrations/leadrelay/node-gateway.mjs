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
  'GET:agent-connection':'/api/agent-builder/connection',
  'POST:agent-voices':'/api/agent-builder/connection/voices',
  'POST:agent-phone-numbers':'/api/agent-builder/connection/phone-numbers',
  'POST:agent-connect':'/api/agent-builder/connection/verify',
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

const CONNECTION_PATH = '/api/agent-builder/connection';
const connectionPaths = new Set([CONNECTION_PATH, CONNECTION_PATH+'/voices', CONNECTION_PATH+'/phone-numbers', CONNECTION_PATH+'/verify']);
const TEST_CALL_PATH = '/api/agent-builder/test-call';
const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value);
function validateOwnerCallBody(body) {
  // Legacy queued tests keep their existing server contract. The one-shot mode
  // has no authority to choose contacts, caller bindings or temporary settings.
  if (!isRecord(body) || !Object.hasOwn(body,'mode')) return;
  const allowed = ['version_id','own_contact_confirmed','ai_call_consent','confirmation','mode','request_id'];
  if (body.mode !== 'call_me' || Object.keys(body).some(key=>!allowed.includes(key))) deny(400,'Unsupported owner call fields');
  if (typeof body.version_id !== 'string' || !body.version_id.trim() || body.version_id.length > 36
      || body.own_contact_confirmed !== true || body.ai_call_consent !== true
      || body.confirmation !== 'PLACE ONE PAID TEST CALL TO MY OWN NUMBER'
      || typeof body.request_id !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(body.request_id)) deny(400,'Explicit own-contact call confirmation and a stable request identifier are required');
}

function safeOwnerCallReceipt(data, body, serverKey) {
  const invalid = () => deny(502,'Unexpected own-contact call receipt; check the same request before retrying');
  const states = ['queued','processing','awaiting_outcome','completed','cancelled','blocked','failed','uncertain'];
  if (!isRecord(data) || data.queued !== true || data.operation_id !== body.request_id
      || typeof data.job_id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(data.job_id)
      || !states.includes(data.status) || data.earliest_delay_seconds !== 0
      || data.maximum_call_seconds !== 180 || data.paid_provider_usage !== true || data.one_call_only !== true) invalid();
  const result = {queued:true,job_id:data.job_id,operation_id:data.operation_id,status:data.status,
    earliest_delay_seconds:0,maximum_call_seconds:180,paid_provider_usage:true,one_call_only:true};
  if (typeof serverKey === 'string' && Object.values(result).some(value=>typeof value === 'string' && value.includes(serverKey))) invalid();
  return result;
}
function validateConnectionBody(path, body) {
  if (path === CONNECTION_PATH) {
    if (body !== undefined) deny(400,'Connection status does not accept a payload');
    return;
  }
  const allowed = path.endsWith('/voices') || path.endsWith('/phone-numbers') ? ['secret'] : ['secret','webhook_secret','voice_id','from_number'];
  if (!isRecord(body) || Object.keys(body).some(key=>!allowed.includes(key))) deny(400,'Unsupported provider setup fields');
  for (const field of ['secret','webhook_secret']) {
    if (Object.hasOwn(body,field) && (typeof body[field] !== 'string' || body[field].trim().length < 10 || body[field].length > 10000 || /[\r\n]/.test(body[field]))) deny(400,'Invalid provider setup credential');
  }
  if (path.endsWith('/verify')) {
    if (typeof body.voice_id !== 'string' || !body.voice_id.trim() || body.voice_id.length > 120 || /[\r\n]/.test(body.voice_id)) deny(400,'Select a provider voice');
    if (Object.hasOwn(body,'from_number') && (typeof body.from_number !== 'string' || body.from_number.length > 20 || /[\r\n]/.test(body.from_number))) deny(400,'Invalid existing caller number');
  }
}

function safeConnectionResponse(path, data, credentials) {
  // The credential-entry endpoints are deliberately narrower than the regular
  // control response. Provider keys and unknown supplier fields never return.
  const invalid = () => deny(502,'Unexpected provider setup response');
  if (!isRecord(data) || data.outreach_started !== false) invalid();
  const text = (value,max=120) => {
    if (typeof value !== 'string' || value.length > max || /[\r\n]/.test(value)) invalid();
    return value;
  };
  const config = raw => {
    if (!isRecord(raw)) invalid();
    const result = {};
    for (const field of ['voice_id','voice_name','from_number']) if (Object.hasOwn(raw,field)) result[field] = text(raw[field],field==='from_number'?20:120);
    if (Object.hasOwn(raw,'verified_at')) {
      if (!Number.isSafeInteger(raw.verified_at) || raw.verified_at < 0) invalid();
      result.verified_at = raw.verified_at;
    }
    return result;
  };
  let result;
  if (path.endsWith('/voices')) {
    if (data.provider !== 'retell' || !Array.isArray(data.voices) || data.voices.length > 200) invalid();
    result = {provider:'retell',voices:data.voices.map(voice=>{
      if (!isRecord(voice)) invalid();
      const row = {voice_id:text(voice.voice_id),voice_name:text(voice.voice_name)};
      if (!row.voice_id || !row.voice_name) invalid();
      for (const field of ['provider','gender','accent','age','language']) if (Object.hasOwn(voice,field)) row[field] = text(voice[field]);
      return row;
    }),outreach_started:false};
  } else if (path.endsWith('/phone-numbers')) {
    if (data.provider !== 'retell' || !Array.isArray(data.phone_numbers) || data.phone_numbers.length > 200 || typeof data.truncated !== 'boolean') invalid();
    result = {provider:'retell',phone_numbers:data.phone_numbers.map(number=>{
      if (!isRecord(number)) invalid();
      const row = {phone_number:text(number.phone_number,20)};
      if (!/^\+[1-9]\d{6,14}$/.test(row.phone_number)) invalid();
      for (const field of ['nickname','number_type']) if (Object.hasOwn(number,field)) row[field] = text(number[field]);
      return row;
    }),truncated:data.truncated,outreach_started:false};
  } else {
    if (typeof data.verified !== 'boolean') invalid();
    result = {verified:data.verified,config:config(data.config),outreach_started:false};
    if (path === CONNECTION_PATH) {
      if (data.provider !== 'retell' || typeof data.has_secret !== 'boolean' || typeof data.has_webhook_secret !== 'boolean') invalid();
      Object.assign(result,{provider:'retell',has_secret:data.has_secret,has_webhook_secret:data.has_webhook_secret});
    }
  }
  const secrets = credentials.filter(value=>typeof value === 'string' && value.length >= 10).flatMap(value=>[value,value.trim()]);
  const exposed = value => typeof value === 'string' ? secrets.some(secret=>value.includes(secret)) : value && typeof value === 'object' ? Object.values(value).some(exposed) : false;
  if (exposed(result)) invalid();
  return result;
}

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
  if (connectionPaths.has(path)) validateConnectionBody(path,body);
  if (path === TEST_CALL_PATH) validateOwnerCallBody(body);
  const upstreamPath = path.startsWith('/api/agent-builder') ? path : '/api/control/'+path;
  const payload=body===undefined?undefined:JSON.stringify(body);
  if(payload&&Buffer.byteLength(payload)>MAX_BYTES) deny(413,'Request exceeds limit');
  try{
    const r=await fetchImpl(installation.origin+upstreamPath,{method,
      headers:{authorization:'Bearer '+installation.key,'content-type':'application/json',accept:'application/json'},
      body:payload,redirect:'error',signal:AbortSignal.timeout(path === '/api/agent-builder/chat' ? 15_000 : 10_000)});
    if(!r.ok){
      await r.body?.cancel();
      if(connectionPaths.has(path) && r.status===400) deny(400,path.endsWith('/phone-numbers') ? 'Owned caller numbers could not be read; check the Retell connection and permissions' : 'Provider connection could not be verified; check the selected voice and credentials');
      const allowed=[401,403,409,422,429];
      deny(allowed.includes(r.status)?r.status:502,'LeadRelay rejected this control request; check connection and permissions');
    }
    if(!(r.headers.get('content-type')||'').startsWith('application/json')){await r.body?.cancel();deny(502,'Unexpected LeadRelay response type');}
    const data=JSON.parse(await boundedResponse(r));
    // Never forward any upstream headers/cookies, raw error bodies or credentials.
    if (connectionPaths.has(path)) return safeConnectionResponse(path,data,[installation.key,body?.secret,body?.webhook_secret]);
    if (path === TEST_CALL_PATH && body?.mode === 'call_me') return safeOwnerCallReceipt(data,body,installation.key);
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
      if (connectionPaths.has(OPERATIONS[action])) validateConnectionBody(OPERATIONS[action],body);
      else if (OPERATIONS[action] === TEST_CALL_PATH && Object.hasOwn(body,'mode')) validateOwnerCallBody(body);
      else if(match[2].startsWith('agent-') && ['installationId','workspaceId','userId','base_url','key','key_env','secret','webhook_secret','provider_key','from_number','to_number','phone','own_phone','recipient'].some(key => Object.hasOwn(body,key))) deny(400,'Agent authority, credentials and call destination are server-controlled');
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
