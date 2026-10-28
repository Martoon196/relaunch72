import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction } from '../db/transaction.js';
import { requestDatabaseContext } from '../db/rls.js';
import { createPgPortalCrmPrincipalResolver } from './crm-pg-service.js';
import type { PortalCrmRequestIdentity } from './crm-service.js';
import type { InvestorSiteSettings,PublicInvestorSite } from './investor-site.js';
import { InvestorMailError } from '../investor-mail/contracts.js';

export const INVESTOR_ROUTE = '/portal/investors';
export interface InvestorBusiness {
  workspaceId: string; ownerName: string; ownerEmail: string; brandName: string;
  accentColor: string; signature: string; senderEmail: string;
  accessState: 'test' | 'pending_payment' | 'active' | 'suspended';
  version: number; paymentReference: string | null;
  productProfileId?: 'martin_howard_property';
  features?: { crm: boolean; enquirySite: boolean; emailWorkflow: boolean; emailWritable: boolean; leadrelay: boolean; readOnly: boolean; endsAt: string | null };
}
export interface InvestorProgramme {
  isAdmin: boolean; selectedWorkspaceId: string;
  workspaces: {id: string; name: string; role: string}[]; businesses: InvestorBusiness[];
}
export interface InvestorRequirements {
  contactId: string; contactName: string; version: number; capital: string;
  locations: string; interests: string; timeframe: string; notes: string;
}
export class InvestorError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const emailPattern = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;
export function investorUuid(value: string): string {
  if (!uuidPattern.test(value)) throw new InvestorError(400, 'Choose a valid record.');
  return value.toLowerCase();
}
function text(value: string | undefined, label: string, maximum: number, optional = false): string {
  const clean = (value ?? '').trim();
  if ((!clean && !optional) || clean.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(clean)) throw new InvestorError(400, `Check ${label}.`);
  return clean;
}
function email(value: string, optional = false): string {
  const clean = text(value, 'the email address', 320, optional).toLowerCase();
  if ((clean || !optional) && !emailPattern.test(clean)) throw new InvestorError(400, 'Enter a valid email address.');
  return clean;
}
function version(value: string): number {
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < 0) throw new InvestorError(400, 'Refresh the record before saving.');
  return n;
}
const hash = (s: string) => createHash('sha256').update(s).digest();
export function investorFailure(error: unknown): InvestorError {
  if (error instanceof InvestorError) return error;
  if(error instanceof InvestorMailError) return new InvestorError(error.code==='invalid_settings'?400:503,
    error.code==='reauthorisation_required'?'Reconnect your mailbox in Business setup.':error.code==='read_failed'?'Replies could not be synced. Your saved conversations are unchanged.':error.code==='invalid_settings'?'Check your email connection settings.':'The mailbox could not be reached. Check the connection in Business setup.');
  const code = typeof error === 'object' && error && 'code' in error ? error.code : '';
  if (code === '42501') return new InvestorError(403, 'You do not have access to this business.');
  if (code === '40001' || code === '23505') return new InvestorError(409, 'This record changed. Refresh it before trying again.');
  if (code === '22023' || code === '23514' || code === '23502') return new InvestorError(400, 'Check the entered details.');
  return new InvestorError(503, 'Investor Desk is temporarily unavailable. No successful save is confirmed.');
}

export class InvestorService {
  constructor(private readonly readPool: Pick<Pool, 'query' | 'connect'>,
    private readonly identityPool: Pick<Pool, 'query'>,
    private readonly commandPool: Pick<Pool, 'connect'>) {}
  async snapshot(identity: PortalCrmRequestIdentity): Promise<InvestorProgramme> {
    const r = await this.readPool.query<{snapshot: InvestorProgramme}>(
      'SELECT app_private.investor_programme_snapshot($1) AS snapshot', [hash(identity.sessionToken)]);
    if (r.rows.length !== 1 || !r.rows[0]?.snapshot) throw new InvestorError(503, 'Investor Desk could not load.');
    return r.rows[0].snapshot;
  }
  async create(identity: PortalCrmRequestIdentity, form: Record<string,string>): Promise<string> {
    const data = { key: investorUuid(form.commandKey ?? ''), brand: text(form.brandName,'the business name',100),
      name: text(form.ownerName,'the owner name',200), email: email(form.ownerEmail ?? ''), test: form.kind === 'test' };
    if (!['test','mentee'].includes(form.kind ?? '')) throw new InvestorError(400,'Choose a test business or mentee.');
    const r = await this.identityPool.query<{id: string}>(
      'SELECT app_private.create_investor_business($1,$2,$3,$4,$5,$6,$7) AS id',
      [hash(identity.sessionToken),data.key,hash(JSON.stringify(data)),data.brand,data.name,data.email,data.test]);
    if (!r.rows[0]?.id) throw new InvestorError(503,'Business creation was not confirmed.');
    return r.rows[0].id;
  }
  async branding(identity: PortalCrmRequestIdentity, form: Record<string,string>): Promise<void> {
    if (!/^#[0-9a-f]{6}$/i.test(form.accentColor ?? '')) throw new InvestorError(400,'Choose a brand colour.');
    await this.identityPool.query('SELECT app_private.update_investor_business($1,$2,$3,$4,$5,$6,$7)',
      [hash(identity.sessionToken),investorUuid(form.workspaceId ?? ''),version(form.version ?? ''),
        text(form.brandName,'the business name',100),form.accentColor,text(form.signature,'the signature',1000,true),email(form.senderEmail ?? '',true)]);
  }
  async access(identity: PortalCrmRequestIdentity, form: Record<string,string>): Promise<string | null> {
    if (!['active','suspended'].includes(form.state ?? '')) throw new InvestorError(400,'Choose an access state.');
    if (form.state === 'active' && form.paymentConfirmed !== 'yes') throw new InvestorError(400,'Confirm payment before activating access.');
    const token = randomBytes(32).toString('base64url');
    const r = await this.identityPool.query<{result: {setupNeeded: boolean}}>(
      'SELECT app_private.set_investor_access($1,$2,$3,$4,$5,$6) AS result',
      [hash(identity.sessionToken),investorUuid(form.workspaceId ?? ''),version(form.version ?? ''),form.state,
        text(form.paymentReference,'the payment reference',200,form.state !== 'active'),hash(token)]);
    if (r.rows.length !== 1) throw new InvestorError(503,'Access change was not confirmed.');
    return r.rows[0]!.result.setupNeeded ? `/portal/setup?token=${token}` : null;
  }
  async switchWorkspace(identity: PortalCrmRequestIdentity, target: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.identityPool.query('SELECT app_private.switch_investor_workspace($1,$2,$3,$4)',
      [hash(identity.sessionToken),investorUuid(target),hash(token),hash(randomBytes(32).toString('base64url'))]);
    return token;
  }
  async site(identity:PortalCrmRequestIdentity):Promise<InvestorSiteSettings|null> {
    const r=await this.readPool.query<{site:InvestorSiteSettings|null}>('SELECT app_private.investor_site_settings($1) AS site',[hash(identity.sessionToken)]);
    return r.rows[0]?.site??null;
  }
  async saveSite(identity:PortalCrmRequestIdentity,form:Record<string,string>):Promise<void> {
    const slug=text(form.slug,'the site address',60);
    if(!/^[a-z0-9][a-z0-9-]{2,59}$/.test(slug))throw new InvestorError(400,'Use 3–60 lowercase letters, numbers and hyphens for the site address.');
    const privacy=text(form.privacyUrl,'the privacy notice URL',2000,true),publish=form.publish==='yes';
    if(privacy) {try {const u=new URL(privacy);if(u.protocol!=='https:'||u.username||u.password)throw new Error();}catch{throw new InvestorError(400,'Enter an HTTPS link to your privacy notice.');}}
    if(publish&&!privacy)throw new InvestorError(400,'Add your privacy notice before publishing.');
    const domain=text(form.domain,'the requested domain',253,true).toLowerCase();
    if(domain&&!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(domain))throw new InvestorError(400,'Enter a domain name without https or a path.');
    await this.identityPool.query('SELECT app_private.save_investor_site($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [hash(identity.sessionToken),version(form.version??''),slug,text(form.headline,'the headline',140),text(form.introduction,'the introduction',1500),text(form.locations,'locations',300,true),email(form.contactEmail??''),privacy,domain,publish]);
  }
  async publicSite(slug:string):Promise<PublicInvestorSite|null> {
    const r=await this.readPool.query<{site:PublicInvestorSite|null}>('SELECT app_private.public_investor_site($1) AS site',[slug]);return r.rows[0]?.site??null;
  }
  async captureSiteEnquiry(slug:string,nonce:string,name:string,address:string,message:string):Promise<void> {
    await this.identityPool.query('SELECT app_private.capture_investor_site_enquiry($1,$2,$3,$4,$5)',[slug,hash(nonce),text(name,'your name',200),email(address),text(message,'your enquiry',4000)]);
  }
  private async context(identity: PortalCrmRequestIdentity) {
    const resolved = await createPgPortalCrmPrincipalResolver(this.readPool).resolve(identity.sessionToken);
    if (!resolved) throw new InvestorError(403,'Sign in again to continue.');
    return requestDatabaseContext({...resolved,requestId:identity.requestId,portalSessionTokenHash:hash(identity.sessionToken)});
  }
  async requirements(identity: PortalCrmRequestIdentity, contactId: string): Promise<InvestorRequirements> {
    const context = await this.context(identity);
    return withTransaction(this.readPool,context,async tx => {
      const r = await tx.query(`SELECT c.id AS "contactId",c.display_name AS "contactName",COALESCE(r.row_version,0)::integer AS version,
        COALESCE(r.capital_notes,'') AS capital,COALESCE(r.locations,'') AS locations,COALESCE(r.interests,'') AS interests,
        COALESCE(r.timeframe,'') AS timeframe,COALESCE(r.notes,'') AS notes
        FROM app.contacts c LEFT JOIN app.investor_requirements r ON r.workspace_id=c.workspace_id AND r.contact_id=c.id
        WHERE c.workspace_id=app_private.current_workspace_id() AND c.id=$1 AND c.deleted_at IS NULL`,[investorUuid(contactId)]);
      if (!r.rows[0]) throw new InvestorError(404,'Investor not found in this workspace.');
      return r.rows[0] as InvestorRequirements;
    },{readOnly:true});
  }
  async saveRequirements(identity: PortalCrmRequestIdentity, form: Record<string,string>): Promise<void> {
    const id = investorUuid(form.contactId ?? ''), expected = version(form.version ?? '');
    const values = [text(form.capital,'capital available',500,true),text(form.locations,'locations',1000,true),text(form.interests,'investment interests',1000,true),text(form.timeframe,'timing',500,true),text(form.notes,'notes',4000,true)];
    const context = await this.context(identity);
    await withTransaction(this.commandPool,context,async tx => {
      const contact = await tx.query(`SELECT id FROM app.contacts WHERE workspace_id=app_private.current_workspace_id() AND id=$1 AND deleted_at IS NULL
        AND app_private.can_write_workspace(app_private.current_user_id(),workspace_id) FOR UPDATE`,[id]);
      if (!contact.rows.length) throw new InvestorError(403,'Investor is unavailable for editing.');
      const old = await tx.query('SELECT row_version FROM app.investor_requirements WHERE workspace_id=app_private.current_workspace_id() AND contact_id=$1',[id]);
      if (Number(old.rows[0]?.row_version ?? 0) !== expected) throw new InvestorError(409,'These requirements changed. Refresh before saving.');
      await tx.query(`INSERT INTO app.investor_requirements(workspace_id,contact_id,capital_notes,locations,interests,timeframe,notes)
        VALUES(app_private.current_workspace_id(),$1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,contact_id) DO UPDATE SET
        capital_notes=EXCLUDED.capital_notes,locations=EXCLUDED.locations,interests=EXCLUDED.interests,timeframe=EXCLUDED.timeframe,notes=EXCLUDED.notes,
        row_version=app.investor_requirements.row_version+1,updated_at=clock_timestamp()`,[id,...values]);
    });
  }
}

export interface InvestorTemplate { id: string; title: string; subject: string; body: string; guidance: string }
export const INVESTOR_TEMPLATES: readonly InvestorTemplate[] = [
  {id:'introduction',title:'First introduction',subject:'Your property investment plans',body:'Hi {{investor}},\n\nThank you for connecting with {{business}}. What are you hoping your next property investment will achieve?\n\nIf useful, we can arrange a short call to discuss your preferred locations, available capital and timing.\n\n{{signature}}',guidance:'Personalise why you are contacting them. Ask one clear question.'},
  {id:'qualification',title:'Understand their requirements',subject:'A few details about your investment plans',body:'Hi {{investor}},\n\nTo understand which opportunities might be relevant, could you share your preferred locations, approximate capital available and intended timescale? Are there any property types or approaches you want to avoid?\n\n{{signature}}',guidance:'Record what they tell you in Requirements. Unknown figures stay unknown.'},
  {id:'meeting',title:'After your conversation',subject:'Following up on our conversation',body:'Hi {{investor}},\n\nThank you for your time. My understanding is:\n[Summarise their stated objectives and requirements.]\n\nOur agreed next step is:\n[Action, owner and date.]\n\nPlease let me know if I have missed anything.\n\n{{signature}}',guidance:'Replace the brackets with the actual discussion and next action.'},
  {id:'opportunity',title:'Introduce an opportunity',subject:'An opportunity to review together',body:'Hi {{investor}},\n\nBased on the requirements we discussed, this opportunity may be worth reviewing:\n[Property, location and source link.]\n\n[Verified figures, assumptions and material uncertainties.]\n\nWould you like to discuss it? Any decision should follow your own due diligence.\n\n{{signature}}',guidance:'Use a Property Predator appraisal link. Check every figure; do not promise returns.'},
  {id:'follow-up',title:'Gentle follow-up',subject:'Would you like to take the next step?',body:'Hi {{investor}},\n\nFollowing up on our last conversation: would you like to discuss the next step, revisit your requirements, or pause for now?\n\n{{signature}}',guidance:'Check for a reply or opt-out before following up. Record their preference.'},
  {id:'call',title:'Investor discovery call',subject:'Discovery call guide',body:'1. Confirm their goal and experience.\n2. Ask which locations and strategies interest them.\n3. Ask what capital and timescale they are comfortable discussing.\n4. Explore concerns and decision criteria.\n5. Summarise what you heard.\n6. Agree one next action, owner and date.',guidance:'Listen first. Do not imply funding, suitability or guaranteed performance.'},
];
export function renderInvestorTemplate(templateId: string, business: InvestorBusiness, investorName: string): InvestorTemplate {
  const template = INVESTOR_TEMPLATES.find(t=>t.id===templateId);
  if (!template) throw new InvestorError(404,'Template not found.');
  const values: Record<string,string> = { investor: investorName.trim() || '[Investor name]',business:business.brandName,signature:business.signature || business.brandName };
  return {...template,body:template.body.replace(/\{\{(investor|business|signature)\}\}/g,(_,key:string)=>values[key]!)};
}
export const investorCommandKey = () => randomUUID();
