import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { withTransaction } from '../../db/transaction.js';
import { requestDatabaseContext, type DatabaseRequestContext } from '../../db/rls.js';
import { CrmCommandService } from '../../crm-pg/commands.js';
import { CrmPgRepository } from '../../crm-pg/repository.js';
import type { CrmTransactionRunner, SqlExecutor } from '../../crm-pg/types.js';
import { MHP_MARKETING_WORKSPACE_ID } from '../../mhp/marketing-workspace-service.js';
import { readOwnerWhatsapp } from './whatsapp-reader.js';

export const GROUP_HQ_INBOX_CRM_PATH = '/api/group-hq/inbox/crm';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const BRAND = /^(pp|mhp|kp|piuk|hnh|ordris|group)$/u;
const CHANNEL = /^(facebook|instagram|linkedin|twitter|whatsapp|youtube|tiktok|email|sms)$/u;
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new InboxCrmError(400, 'invalid_request');
  return value;
}
function uuid(value: unknown): string {
  const parsed = text(value, 36).toLowerCase();
  if (!UUID.test(parsed)) throw new InboxCrmError(400, 'invalid_request');
  return parsed;
}
export class InboxCrmError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export interface InboxCrmScope {
  label: string; workspaceId: string; organizationId: string; ownerUserId: string;
  pipelineId: string; stageId: string; actorEmails: readonly string[]; whatsappOwnerIds?: Readonly<Record<string,string>>;
}
export interface InboxCrmConfig { secret: string; scopes: Readonly<Record<string, InboxCrmScope>>; mhpWhatsappInboxId?: string; mhpWhatsappManualReplies?: boolean }
export function loadInboxCrmConfig(env: NodeJS.ProcessEnv): InboxCrmConfig | undefined {
  const raw = env.R72_GROUP_HQ_INBOX_SCOPES?.trim() ?? '';
  const secret = env.R72_GROUP_HQ_INBOX_SECRET?.trim() ?? '';
  if (!raw && !secret) return undefined;
  if (secret.length < 32 || secret.length > 256) throw new Error('Inbox command credential is incomplete');
  const parsed: unknown = JSON.parse(raw);
  if (!record(parsed) || !Object.keys(parsed).length || Object.keys(parsed).length > 7) throw new Error('Inbox scope configuration is invalid');
  const scopes: Record<string, InboxCrmScope> = {};
  const workspaces = new Set<string>();
  for (const [brand, value] of Object.entries(parsed)) {
    if (!BRAND.test(brand) || !record(value) || !Array.isArray(value.actorEmails) || !value.actorEmails.length
        || value.actorEmails.length > 10 || value.actorEmails.some(e => typeof e !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(e))) {
      throw new Error('Inbox scope configuration is invalid');
    }
    const workspaceId = uuid(value.workspaceId);
    if (workspaces.has(workspaceId)) throw new Error('Inbox brands cannot share a workspace mapping');
    workspaces.add(workspaceId);
    scopes[brand] = { label: text(value.label, 200), workspaceId, organizationId: uuid(value.organizationId),
      ownerUserId: uuid(value.ownerUserId), pipelineId: uuid(value.pipelineId), stageId: uuid(value.stageId),
      actorEmails: value.actorEmails.map(e => String(e).toLowerCase()) };
    if (brand === 'mhp' && env.GHQ_MHP_WHATSAPP_OWNER_IDS) {
      const mapping: unknown=JSON.parse(env.GHQ_MHP_WHATSAPP_OWNER_IDS);
      if (!record(mapping)) throw new Error('Invalid WhatsApp owner mapping');
      const owners: Record<string,string> = {};
      for (const [email,id] of Object.entries(mapping)) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) || email!==email.toLowerCase()) throw new Error('Invalid WhatsApp inbox actor');
        owners[email]=uuid(id);
      }
      scopes[brand]!.whatsappOwnerIds=owners;
    }
  }
  const binding = env.GHQ_MHP_WHATSAPP_INBOX_ID?.trim();
  return binding && UUID.test(binding) ? { secret, scopes, mhpWhatsappInboxId: binding.toLowerCase(),
    ...(env.MHP_WHATSAPP_MANUAL_REPLIES==='enabled'?{mhpWhatsappManualReplies:true}:{}) } : {secret, scopes};
}

export function inboxSignature(secret: string, timestamp: string, method: string, path: string, body: Buffer): string {
  return createHmac('sha256', secret).update(`${timestamp}\n${method}\n${path}\n`).update(body).digest('hex');
}
export function verifyInboxSignature(secret: string, timestamp: unknown, signature: unknown, body: Buffer, now = Date.now()): boolean {
  if (typeof timestamp !== 'string' || !/^\d{10}$/u.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300
      || typeof signature !== 'string' || !/^[0-9a-f]{64}$/u.test(signature)) return false;
  const expected = inboxSignature(secret, timestamp, 'POST', GROUP_HQ_INBOX_CRM_PATH, body);
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
}

export interface InboxSource { channel: string; accountId: string; participantId: string; threadId: string }
function source(value: unknown): InboxSource {
  if (!record(value) || !CHANNEL.test(String(value.channel))) throw new InboxCrmError(400, 'invalid_source');
  return { channel: String(value.channel), accountId: text(value.accountId, 500),
    participantId: text(value.participantId, 500), threadId: text(value.threadId, 500) };
}
export function inboxSocialPoint(input: InboxSource): string {
  // Exact native IDs are hashed before the core social normaliser lowercases text.
  // This neither invents an email nor verifies a point or grants marketing consent.
  return `${input.channel}:ghq:${sha(JSON.stringify([input.channel, input.accountId, input.participantId]))}`;
}

export class GroupHqInboxCrmService {
  private readonly commands: CrmCommandService;
  constructor(private readonly readPool: Pick<Pool, 'connect'>, private readonly runner: CrmTransactionRunner,
              private readonly config: InboxCrmConfig) {
    this.commands = new CrmCommandService({ transactionRunner: runner });
  }
  private async context(actorEmail: string, brand: string, requestId: string): Promise<{ context: DatabaseRequestContext; scope: InboxCrmScope }> {
    const scope = this.config.scopes[brand];
    if (!scope || !scope.actorEmails.includes(actorEmail.toLowerCase())) throw new InboxCrmError(403, 'forbidden_scope');
    const context = requestDatabaseContext({ workspaceId: scope.workspaceId, userId: scope.ownerUserId, requestId });
    const allowed = await withTransaction(this.readPool, context, async tx => {
      const result = await tx.query<{ allowed: boolean }>(`/* group-hq.inbox.scope */
        SELECT app_private.can_manage_workspace($1::uuid,$2::uuid)
          AND EXISTS(SELECT 1 FROM app.workspaces w WHERE w.id=$2::uuid AND w.organization_id=$3::uuid AND w.status='active') AS allowed`,
        [scope.ownerUserId, scope.workspaceId, scope.organizationId]);
      return result.rows.length === 1 && result.rows[0]!.allowed === true;
    }, { readOnly: true });
    if (!allowed) throw new InboxCrmError(403, 'forbidden_scope');
    return { context, scope };
  }

  async execute(input: unknown): Promise<unknown> {
    if (!record(input)) throw new InboxCrmError(400, 'invalid_request');
    const actorEmail = text(input.actorEmail, 254).toLowerCase();
    const requestId = uuid(input.requestId);
    const brand = text(input.brand, 12);
    const { context, scope } = await this.context(actorEmail, brand, requestId);
    if (input.action === 'whatsappThreads' || input.action === 'whatsappMessages' || input.action === 'whatsappReply') {
      const inboxId = this.config.mhpWhatsappInboxId;
      if (brand !== 'mhp' || scope.workspaceId !== MHP_MARKETING_WORKSPACE_ID || !inboxId || input.accountId !== inboxId) {
        throw new InboxCrmError(403,'forbidden_scope');
      }
      const thread = input.action === 'whatsappThreads' ? undefined : uuid(input.threadId);
      const cursor = thread && input.cursor != null ? uuid(input.cursor) : undefined;
      const actorId=scope.whatsappOwnerIds?.[actorEmail] ?? scope.ownerUserId;
      const ownerContext=requestDatabaseContext({workspaceId:scope.workspaceId,userId:actorId,requestId});
      const result = await readOwnerWhatsapp(this.readPool, ownerContext, actorEmail, inboxId, thread, cursor);
      if (!result) throw new InboxCrmError(404,'conversation_unavailable');
      if (input.action === 'whatsappReply') {
        if (!this.config.mhpWhatsappManualReplies) throw new InboxCrmError(409,'reply_unavailable');
        const body=text(input.body,4096);
        if (Buffer.byteLength(body)>4096) throw new InboxCrmError(400,'invalid_request');
        const state=await this.runner.run(ownerContext,async tx=>{
          const {rows}=await tx.query<{state:string}>('SELECT app_private.mhp_wa_direct_queue($1,$2,$3,$4) AS state',[requestId,inboxId,thread,body]);
          return rows[0]?.state;
        });
        if (!state || state==='refused' || state==='conflict') throw new InboxCrmError(409,state==='conflict'?'request_conflict':'reply_unavailable');
        return {brand,accountId:inboxId,threadId:thread,requestId,state};
      }
      return result;
    }
    if (input.action === 'contact') {
      const contactId=uuid(input.contactId);
      return this.runner.run(context,async tx=>{
        const contact=await tx.query(`SELECT id,display_name AS name,lifecycle_status AS lifecycle,source
          FROM app.contacts WHERE id=$1::uuid AND workspace_id=app_private.current_workspace_id() AND deleted_at IS NULL`,[contactId]);
        if(contact.rows.length!==1)throw new InboxCrmError(404,'contact_not_found');
        const activities=await tx.query(`SELECT id,activity_type AS type,channel,subject,body,occurred_at AS "occurredAt"
          FROM app.activities WHERE contact_id=$1::uuid AND workspace_id=app_private.current_workspace_id()
          ORDER BY occurred_at DESC,id DESC LIMIT 10`,[contactId]);
        return {contactId,workspaceId:scope.workspaceId,brand,contact:contact.rows[0],activities:activities.rows};
      });
    }
    if (input.action === 'search') {
      const query = text(input.query, 200).trim();
      return this.runner.run(context, async tx => {
        const result = await tx.query(`/* group-hq.inbox.contact-search */
          SELECT id,display_name AS name FROM app.contacts WHERE workspace_id=app_private.current_workspace_id()
           AND deleted_at IS NULL AND lifecycle_status<>'archived' AND position(lower($1) in lower(display_name))>0
          ORDER BY display_name,id LIMIT 20`, [query]);
        return { contacts: result.rows, workspaceId: scope.workspaceId };
      });
    }
    const origin = source(input.source);
    const point = inboxSocialPoint(origin);
    const threadHash = sha(JSON.stringify([origin.channel, origin.accountId, origin.threadId]));
    if (input.action === 'create') {
      const name = text(input.displayName, 200).trim();
      const result = await this.commands.createLead(context, { commandKey: `ghq.inbox.create.${threadHash}`,
        displayName: name, source: `growth_hq_inbox:${origin.channel}`, ownerUserId: scope.ownerUserId,
        contactPoints: [{ kind: 'social', label: origin.channel, value: point, isPrimary: true, consentStatus: 'unknown' }],
        pipelineId: scope.pipelineId, stageId: scope.stageId, opportunityName: `${origin.channel} enquiry · ${name}`.slice(0, 200),
        valueMinor: 0, currency: 'GBP' });
      return { ...result, workspaceId: scope.workspaceId, brand };
    }
    if (input.action !== 'link' && input.action !== 'activity') throw new InboxCrmError(400, 'invalid_action');
    const contactId = uuid(input.contactId);
    const payload = input.action === 'link' ? { action: 'link', point, contactId, threadHash }
      : { action: 'activity', point, contactId, threadHash, message: this.message(input.message) };
    const payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest();
    const key = input.action === 'link' ? `ghq.inbox.link.${threadHash}`
      : `ghq.inbox.message.${sha(JSON.stringify([threadHash, payload.message!.id, payload.message!.revision]))}`;
    return this.runner.run(context, async tx => {
      const repository = new CrmPgRepository(tx);
      const claim = await repository.claimCommand({ id: randomUUID(), commandName: `ghq.inbox.${input.action}`,
        commandKey: key, requestId, actorUserId: scope.ownerUserId, payloadHash, createdAt: new Date().toISOString() });
      if (!Buffer.from(claim.payloadHash).equals(payloadHash)) throw new InboxCrmError(409, 'request_conflict');
      if (!claim.inserted) {
        if (claim.status !== 'succeeded') throw new InboxCrmError(409, 'request_in_progress');
        return claim.result;
      }
      const contact = await tx.query(`SELECT id FROM app.contacts WHERE id=$1::uuid AND workspace_id=app_private.current_workspace_id()
        AND deleted_at IS NULL AND lifecycle_status<>'archived' FOR UPDATE`, [contactId]);
      if (contact.rows.length !== 1) throw new InboxCrmError(404, 'contact_not_found');
      const existing = await repository.findContactPoint('social', point);
      if (input.action === 'link') {
        if (existing && existing.contactId !== contactId) throw new InboxCrmError(409, 'identity_already_linked');
        if (!existing) {
          const inserted = await repository.insertContactPoint({ id: randomUUID(), contactId, kind: 'social', label: origin.channel,
            value: point, normalizedValue: point, isPrimary: !(await repository.hasPrimaryContactPoint(contactId, 'social')),
            consentStatus: 'unknown', createdAt: new Date().toISOString() });
          if (!inserted) throw new InboxCrmError(409, 'identity_already_linked');
        }
      } else if (!existing || existing.contactId !== contactId || existing.contactState !== 'active') {
        throw new InboxCrmError(409, 'identity_not_linked');
      }
      const message = payload.message;
      const at = new Date();
      const activityId = randomUUID();
      await tx.query(`/* group-hq.inbox.activity */ INSERT INTO app.activities
        (id,workspace_id,contact_id,activity_type,channel,actor_kind,actor_user_id,subject,body,metadata,request_id,correlation_id,occurred_at,created_at)
        VALUES($1::uuid,app_private.current_workspace_id(),$2::uuid,$3,'social','user',$4::uuid,$5,$6,$7::jsonb,$8,$9,$10::timestamptz,$11::timestamptz)`,
        [activityId,contactId,input.action === 'link' ? 'social.conversation.linked' : 'social.message.recorded',scope.ownerUserId,
         input.action === 'link' ? `${origin.channel} conversation linked` : `${origin.channel} · ${message!.direction === 'outgoing' ? 'Sent' : 'Received'}`,
         message?.body ?? null,JSON.stringify({ source: 'growth_hq_inbox', channel: origin.channel, accountId: origin.accountId,
           threadId: origin.threadId, actorEmail, providerEvidence: 'connector_assertion', messageId: message?.id ?? null,
           revision: message?.revision ?? null, direction: message?.direction ?? null }),requestId,activityId,
         message?.occurredAt ?? at.toISOString(),at.toISOString()]);
      const result = { contactId, workspaceId: scope.workspaceId, activityId, brand };
      await repository.completeCommand({ receiptId: claim.id, payloadHash, result, completedAt: new Date().toISOString() });
      return result;
    });
  }
  private message(value: unknown) {
    if (!record(value) || !['incoming','outgoing'].includes(String(value.direction))) throw new InboxCrmError(400, 'invalid_message');
    const occurredAt = new Date(text(value.occurredAt, 100));
    if (!Number.isFinite(occurredAt.getTime()) || occurredAt.getTime() > Date.now()) throw new InboxCrmError(400, 'invalid_message');
    return { id: text(value.id, 500), revision: value.revision == null || value.revision === '' ? '' : text(value.revision, 100),
      direction: String(value.direction), body: text(value.body, 20000), occurredAt: occurredAt.toISOString() };
  }
}

/** Revalidate current owner management inside every command transaction. No native session is forged. */
export function createInboxCrmRunner(pool: Pick<Pool,'connect'>): CrmTransactionRunner {
  return { async run<T>(context: DatabaseRequestContext, operation: (tx: SqlExecutor) => Promise<T>) {
    return withTransaction(pool, context, async tx => {
      const allowed = await tx.query<{ allowed: boolean }>('SELECT app_private.can_manage_workspace($1::uuid,$2::uuid) AS allowed',
        [context.userId,context.workspaceId]);
      if (allowed.rows.length !== 1 || allowed.rows[0]!.allowed !== true) throw new InboxCrmError(403, 'forbidden_scope');
      return operation({ async query<R extends Record<string,unknown>>(sql: string, values?: readonly unknown[]) {
        const result = await tx.query<R>(sql, values ? [...values] : undefined);
        return { rows: result.rows, rowCount: result.rowCount };
      } });
    });
  } };
}

function reply(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type':'application/json; charset=utf-8','cache-control':'no-store' });
  res.end(JSON.stringify(value));
}
export function createGroupHqInboxCrmMount(readPool: Pick<Pool,'connect'>, commandPool: Pick<Pool,'connect'>, config: InboxCrmConfig) {
  const service = new GroupHqInboxCrmService(readPool,createInboxCrmRunner(commandPool),config);
  return { async handle(req: IncomingMessage,res: ServerResponse,url: URL) {
    if (req.method !== 'POST' || url.pathname !== GROUP_HQ_INBOX_CRM_PATH || url.search) return reply(res,404,{ error:'not_found' });
    try {
      const chunks: Buffer[] = [];let size = 0;
      for await (const chunk of req) { const bytes=Buffer.from(chunk);size+=bytes.length;
        if(size>128000) return reply(res,413,{error:'request_too_large'});chunks.push(bytes); }
      const body=Buffer.concat(chunks);
      if (!verifyInboxSignature(config.secret,req.headers['x-ghq-timestamp'],req.headers['x-ghq-signature'],body)) return reply(res,401,{error:'unauthorised'});
      let input: unknown;try {input=JSON.parse(body.toString('utf8'));} catch {return reply(res,400,{error:'invalid_request'});}
      return reply(res,200,await service.execute(input));
    } catch(error) {
      return reply(res,error instanceof InboxCrmError ? error.status : 503,
        {error:error instanceof InboxCrmError ? error.code : 'temporarily_unavailable'});
    }
  } };
}
