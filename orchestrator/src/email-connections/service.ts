/**
 * "Connect email": the state machine behind the owner's screens.
 *
 * Connect (and Continue) run under one lock per business, across every instance. Each step writes its intent first,
 * then FINDS before it CREATES, so a run interrupted anywhere is adopted on Continue and a double press creates
 * nothing twice:
 *   1. server   "Relaunch72 · <business> · <workspace short id>": the stored id, else a server of exactly that name,
 *               else a new one (603 "name exists" is adopted the same way). Its token is sealed and saved.
 *   2. stream   the Broadcast stream "broadcast": listed first, created only when missing (1230 is adopted).
 *   3. secret   a fresh 32-byte webhook secret is generated, sealed and SAVED before the webhook exists, and the bounce
 *               source is put in force in this process, so Postmark's set-up samples are answered.
 *   4. webhook  bounces, spam reports and subscription changes on that stream, at
 *               <portal origin>/api/provider-webhooks/postmark/<source key>, Basic user = source key. One already there
 *               for our address with our secret is adopted; one with another secret is replaced.
 *   5. domain   the stored domain id, else a new domain with Return-Path pm-bounces.<domain>. "Already exists" (512) is
 *               adopted ONLY when this business's own run started creating it; anything else is another business's.
 * Then the connection waits for the two DNS records ('dns_pending'). "Check" asks Postmark to verify both and stores
 * Postmark's answer; our own DNS look-ups only choose the clearest message.
 *
 * Nothing at Postmark is touched until the owner has agreed to the current email rules. Nothing here sends email:
 * mode stays 'off' (release 2 adds test and live).
 */
import { randomBytes } from 'node:crypto';
import type { PortalSessionIdentity } from '../portal/auth-service.js';
import { emailConnectBusiness, type EmailConnectBusiness, type EmailConnectConfig } from './config.js';
import { connectionBounceSource } from './bounce-sources.js';
import { freeMailboxDomain, lookUpCname, lookUpDnsHost, lookUpTxt, parseEmailAddress, reservedDomain, systemDnsResolver, type DnsHost, type DnsResolver, type DnsSeen } from './domains.js';
import { createPostmarkAccountApi, POSTMARK_CODES, PostmarkAccountError, type PostmarkAccountApi, type PostmarkDomain, type PostmarkServerApi } from './postmark-account-api.js';
import { EmailConnectionAbsentError, EmailConnectionForbiddenError, type EmailConnectionDns, type EmailConnectionState, type EmailConnectionStep, type EmailConnectionStore, type StepOutcome } from './store.js';
import { EMAIL_TERMS_VERSION } from './terms.js';
import type { EmailBounceSource } from '../email-bounces/index.js';

export const BROADCAST_STREAM = 'broadcast';
const LOCK_WAIT_MS = 45_000;

/** Every sentence the owner can see from this service. Plain English; never a provider message, an id or a setting name. */
export const EMAIL_CONNECTION_MESSAGES = Object.freeze({
  freeMailbox: (domain: string) => `That's a free mailbox (${domain}). Use an address on your own domain.`,
  reservedDomain: 'That address can\'t receive email. Use an address on your own domain.',
  domainTaken: 'That domain is already connected to another business.',
  busy: 'The email service is busy. Try again in a minute.',
  off: 'Email connection isn\'t switched on yet.',
  awaitingApproval: 'Your email account is awaiting approval, so for now it can only email your own domain.',
  unfinished: 'We couldn\'t finish setting up. Press Continue.',
  termsFirst: 'Tick the email rules first.',
  needName: 'Enter the sender name (up to 100 letters, no < or >).',
  needFrom: 'Enter the address to send from, on your own domain, like hello@yourbusiness.co.uk.',
  needReplyTo: 'Enter a valid address for replies, or leave it empty.',
  alreadyConnected: 'Email is already connected for this business. Disconnect it first to use another address.',
  notOwner: 'Only an owner of this business can connect its email.',
  notAllowed: 'Email can only be connected for Property Predator for now.',
  checkBoth: 'Both found. Your email is connected.',
  checkOne: (kind: 'TXT' | 'CNAME') => `Found 1 of 2: the ${kind} record is missing.`,
  checkNone: 'Not found yet. This can take up to 48 hours; press Check again later.',
  checkMismatch: 'The value doesn\'t match. Copy it again from this page.',
  started: 'Nearly there. Add the 2 records below where your domain is managed, then press Check.',
  connectedNext: 'Connected. Sending is switched on in the next step.',
  disconnected: 'Email is disconnected. Nothing was deleted at the email service; you can connect again at any time.',
  nothingToCheck: 'There is nothing to check yet.',
});

export class EmailConnectionError extends Error {
  override readonly name = 'EmailConnectionError';
  constructor(readonly status: number, message: string, readonly code: string) { super(message); }
}

export type EmailConnectionView =
  | { readonly offered: false; readonly message: string }
  | { readonly offered: true; readonly business: EmailConnectBusiness; readonly state: EmailConnectionState; readonly dnsHost: DnsHost | null };

export interface EmailConnectionResult { readonly ok: boolean; readonly message: string }

export interface EmailConnectionBounceHook {
  apply(source: EmailBounceSource): void;
  remove(workspaceId: string): void;
}

/** The deterministic Postmark server name for a business. */
export const connectionServerName = (business: EmailConnectBusiness): string => `Relaunch72 · ${business.name} · ${business.workspaceId.slice(0, 8)}`;
export const connectionWebhookUrl = (origin: string, business: EmailConnectBusiness): string => `${origin}/api/provider-webhooks/postmark/${business.sourceKey}`;
const recordsOf = (domain: PostmarkDomain): EmailConnectionDns => Object.freeze({
  dkim: Object.freeze({ host: domain.dkimHost, value: domain.dkimValue, verified: domain.dkimVerified }),
  returnPath: Object.freeze({ host: domain.returnPathHost, value: domain.returnPathValue, verified: domain.returnPathVerified }),
});

class StepFailure extends Error {
  constructor(readonly outcome: StepOutcome, readonly ownerMessage: string) { super(outcome); }
}

/** What a Postmark failure means for the owner, and the code recorded for the step. */
function failureOf(error: unknown, domain = 'that domain'): StepFailure {
  if (error instanceof StepFailure) return error;
  if (error instanceof PostmarkAccountError) {
    if (error.category === 'busy' || error.category === 'timeout' || error.category === 'network') return new StepFailure('busy', EMAIL_CONNECTION_MESSAGES.busy);
    if (error.category === 'unauthorized') return new StepFailure('unauthorized', EMAIL_CONNECTION_MESSAGES.off);
    if (error.errorCode === POSTMARK_CODES.pendingApproval || error.errorCode === POSTMARK_CODES.notApproved) return new StepFailure('awaiting_approval', EMAIL_CONNECTION_MESSAGES.awaitingApproval);
    if (error.errorCode === POSTMARK_CODES.limitReached) return new StepFailure('plan_limit', EMAIL_CONNECTION_MESSAGES.unfinished);
    if (error.errorCode === POSTMARK_CODES.publicDomain) return new StepFailure('public_domain', EMAIL_CONNECTION_MESSAGES.freeMailbox(domain));
    return new StepFailure('refused', EMAIL_CONNECTION_MESSAGES.unfinished);
  }
  return new StepFailure('failed', EMAIL_CONNECTION_MESSAGES.unfinished);
}

export class EmailConnectionService {
  private readonly account: PostmarkAccountApi | null;
  private readonly serverApi: (token: string) => PostmarkServerApi;
  private readonly resolver: DnsResolver;
  private readonly log: (line: string) => void;
  private readonly secret: () => string;

  constructor(private readonly input: {
    config: EmailConnectConfig;
    store: EmailConnectionStore;
    account?: PostmarkAccountApi;
    resolver?: DnsResolver;
    bounces?: EmailConnectionBounceHook;
    log?: (line: string) => void;
    /** Test seam for the webhook secret; production uses 32 random bytes. */
    secret?: () => string;
    lockWaitMs?: number;
  }) {
    const config = input.config;
    this.account = input.account ?? (config.enabled ? createPostmarkAccountApi({ accountToken: config.accountToken }) : null);
    this.serverApi = token => this.account!.server(token);
    this.resolver = input.resolver ?? systemDnsResolver();
    this.log = input.log ?? (() => undefined);
    this.secret = input.secret ?? (() => randomBytes(32).toString('base64url'));
  }

  /** The configuration allows the feature (the database may still lack 0155: then the page says it is not on yet). */
  get enabled(): boolean { return this.input.config.enabled && this.account !== null; }

  private business(identity: PortalSessionIdentity): EmailConnectBusiness {
    const business = emailConnectBusiness(identity.workspaceId);
    if (!business) throw new EmailConnectionError(403, EMAIL_CONNECTION_MESSAGES.notAllowed, 'not_allowed');
    return business;
  }

  private async read(identity: PortalSessionIdentity, business: EmailConnectBusiness): Promise<EmailConnectionState> {
    try { return await this.input.store.state(identity.sessionToken, business.workspaceId); }
    catch (error) { throw this.storeError(error); }
  }

  private storeError(error: unknown): Error {
    if (error instanceof EmailConnectionAbsentError) return new EmailConnectionError(404, EMAIL_CONNECTION_MESSAGES.off, 'off');
    if (error instanceof EmailConnectionForbiddenError) return new EmailConnectionError(403, EMAIL_CONNECTION_MESSAGES.notOwner, 'not_owner');
    return error instanceof EmailConnectionError || error instanceof StepFailure ? error : new EmailConnectionError(503, EMAIL_CONNECTION_MESSAGES.busy, 'store');
  }

  /** What the page shows. Never throws for "not switched on": that is a page of its own. */
  async view(identity: PortalSessionIdentity): Promise<EmailConnectionView> {
    if (!this.enabled) return { offered: false, message: EMAIL_CONNECTION_MESSAGES.off };
    const business = this.business(identity);
    let state: EmailConnectionState;
    try { state = await this.read(identity, business); }
    catch (error) { if (error instanceof EmailConnectionError && error.code === 'off') return { offered: false, message: EMAIL_CONNECTION_MESSAGES.off }; throw error; }
    const dnsHost = state.status === 'dns_pending' && state.domain ? await lookUpDnsHost(this.resolver, state.domain) : null;
    return { offered: true, business, state, dnsHost };
  }

  private async locked<T>(business: EmailConnectBusiness, work: () => Promise<T>): Promise<T> {
    let release: (() => Promise<void>) | null;
    try { release = await this.input.store.lock(business.workspaceId, this.input.lockWaitMs ?? LOCK_WAIT_MS); }
    catch (error) { throw this.storeError(error); }
    if (!release) throw new EmailConnectionError(409, EMAIL_CONNECTION_MESSAGES.busy, 'locked');
    try { return await work(); } finally { await release(); }
  }

  /** "Connect": validates, records the agreement to the rules, saves the details, then runs the steps. */
  async connect(identity: PortalSessionIdentity, form: { fromName: string; fromAddress: string; replyTo: string; agreed: boolean }): Promise<EmailConnectionResult> {
    if (!this.enabled) throw new EmailConnectionError(404, EMAIL_CONNECTION_MESSAGES.off, 'off');
    const business = this.business(identity);
    const fromName = form.fromName.trim();
    if (!fromName || fromName.length > 100 || /[\u0000-\u001f\u007f<>"\\]/u.test(fromName)) throw new EmailConnectionError(400, EMAIL_CONNECTION_MESSAGES.needName, 'name');
    const from = parseEmailAddress(form.fromAddress);
    if (!from) throw new EmailConnectionError(400, EMAIL_CONNECTION_MESSAGES.needFrom, 'from');
    // Refused before Postmark is ever called.
    if (freeMailboxDomain(from.domain)) throw new EmailConnectionError(400, EMAIL_CONNECTION_MESSAGES.freeMailbox(from.domain), 'free_mailbox');
    if (reservedDomain(from.domain)) throw new EmailConnectionError(400, EMAIL_CONNECTION_MESSAGES.reservedDomain, 'reserved');
    const replyTo = form.replyTo.trim() ? parseEmailAddress(form.replyTo) : null;
    if (form.replyTo.trim() && (!replyTo || reservedDomain(replyTo.domain))) throw new EmailConnectionError(400, EMAIL_CONNECTION_MESSAGES.needReplyTo, 'reply_to');
    // The rules are agreed to on the server; an unticked box changes nothing at all.
    if (!form.agreed) throw new EmailConnectionError(400, EMAIL_CONNECTION_MESSAGES.termsFirst, 'terms');
    return this.locked(business, async () => {
      let begun;
      try {
        await this.input.store.acceptTerms(identity.sessionToken, business.workspaceId, EMAIL_TERMS_VERSION);
        begun = await this.input.store.begin(identity.sessionToken, business.workspaceId,
          { domain: from.domain, fromName, fromAddress: from.address, replyTo: replyTo?.address ?? null }, EMAIL_TERMS_VERSION);
      } catch (error) { throw this.storeError(error); }
      if (begun === 'terms_required') throw new EmailConnectionError(409, EMAIL_CONNECTION_MESSAGES.termsFirst, 'terms');
      if (begun === 'domain_taken') throw new EmailConnectionError(409, EMAIL_CONNECTION_MESSAGES.domainTaken, 'domain_taken');
      if (begun === 'already_connected') throw new EmailConnectionError(409, EMAIL_CONNECTION_MESSAGES.alreadyConnected, 'already_connected');
      return this.run(identity, business);
    });
  }

  /** "Continue" after an interruption: the same steps on the saved details, adopting whatever already exists. */
  async continue(identity: PortalSessionIdentity): Promise<EmailConnectionResult> {
    if (!this.enabled) throw new EmailConnectionError(404, EMAIL_CONNECTION_MESSAGES.off, 'off');
    const business = this.business(identity);
    return this.locked(business, async () => {
      const state = await this.read(identity, business);
      if (state.status !== 'creating' && state.status !== 'needs_attention') return { ok: true, message: state.status === 'verified' ? EMAIL_CONNECTION_MESSAGES.connectedNext : EMAIL_CONNECTION_MESSAGES.started };
      return this.run(identity, business);
    });
  }

  private async run(identity: PortalSessionIdentity, business: EmailConnectBusiness): Promise<EmailConnectionResult> {
    const { store } = this.input, token = identity.sessionToken, ws = business.workspaceId;
    const config = this.input.config;
    if (!config.enabled) throw new EmailConnectionError(404, EMAIL_CONNECTION_MESSAGES.off, 'off');
    const account = this.account!;
    const state = await this.read(identity, business);
    // The rules must be agreed to for the CURRENT version before any Postmark call, on Continue too.
    if (state.terms?.version !== EMAIL_TERMS_VERSION) throw new EmailConnectionError(409, EMAIL_CONNECTION_MESSAGES.termsFirst, 'terms');
    if (!state.domain) throw new EmailConnectionError(409, EMAIL_CONNECTION_MESSAGES.unfinished, 'no_details');
    let step: EmailConnectionStep = 'server';
    const intend = async (next: EmailConnectionStep) => { step = next; await store.intend(token, ws, next); };
    try {
      // 1. Server.
      await intend('server');
      const name = connectionServerName(business);
      let server = state.serverId ? await account.getServer(state.serverId).catch(error => {
        if (error instanceof PostmarkAccountError && error.category === 'not_found') return null;
        throw error;
      }) : null;
      let serverOutcome: StepOutcome = 'adopted';
      if (!server) server = (await account.listServers(name)).find(item => item.name === name) ?? null;
      if (!server) {
        try { server = await account.createServer({ name, color: 'Turquoise' }); serverOutcome = 'created'; }
        catch (error) {
          if (!(error instanceof PostmarkAccountError && error.errorCode === POSTMARK_CODES.serverNameExists)) throw error;
          server = (await account.listServers(name)).find(item => item.name === name) ?? null;
          if (!server) throw error;
        }
      }
      const serverToken = server.serverToken ?? (await account.getServer(server.id)).serverToken;
      if (!serverToken) throw new StepFailure('failed', EMAIL_CONNECTION_MESSAGES.unfinished);
      await store.saveSealed(token, ws, 'server_token', config.vault.seal(ws, 'server_token', serverToken));
      await store.record(token, ws, 'server', serverOutcome, { serverId: server.id });
      const serverApi = this.serverApi(serverToken);

      // 2. Broadcast stream.
      await intend('stream');
      let streamOutcome: StepOutcome = 'adopted';
      if (!(await serverApi.listBroadcastStreams()).some(stream => stream.id === BROADCAST_STREAM)) {
        try { await serverApi.createBroadcastStream(BROADCAST_STREAM, 'Broadcasts'); streamOutcome = 'created'; }
        catch (error) {
          if (!(error instanceof PostmarkAccountError && error.errorCode === POSTMARK_CODES.streamIdExists)) throw error;
          const again = (await serverApi.listBroadcastStreams(true)).find(stream => stream.id === BROADCAST_STREAM);
          // An archived stream of that name cannot be used; that needs a person.
          if (!again || again.archived) throw new StepFailure('failed', EMAIL_CONNECTION_MESSAGES.unfinished);
        }
      }
      await store.record(token, ws, 'stream', streamOutcome, { stream: BROADCAST_STREAM });

      // 3. Webhook secret: saved before the webhook exists, and put in force here so Postmark's samples are answered.
      await intend('secret');
      const sealed = await store.sealed(token, ws);
      let secret: string;
      if (sealed.webhookSecret) secret = config.vault.open(ws, 'webhook_secret', sealed.webhookSecret);
      else {
        secret = this.secret();
        await store.saveSealed(token, ws, 'webhook_secret', config.vault.seal(ws, 'webhook_secret', secret));
      }
      this.input.bounces?.apply(connectionBounceSource({ workspaceId: ws, serverId: String(server.id), stream: BROADCAST_STREAM, serverToken, webhookSecret: secret }));

      // 4. Webhook.
      await intend('webhook');
      const url = connectionWebhookUrl(config.webhookOrigin, business);
      const existing = (await serverApi.listWebhooks(BROADCAST_STREAM)).filter(hook => hook.url === url);
      let webhook = existing.find(hook => hook.username === business.sourceKey && hook.password === secret) ?? null;
      // Ours by address but with another secret (an older run): replaced, so only the saved secret is ever accepted.
      for (const stale of existing) if (stale !== webhook) await serverApi.deleteWebhook(stale.id).catch(error => {
        if (!(error instanceof PostmarkAccountError && (error.category === 'not_found' || error.errorCode === POSTMARK_CODES.webhookNotFound))) throw error;
      });
      let webhookOutcome: StepOutcome = 'adopted';
      if (!webhook) { webhook = await serverApi.createWebhook({ url, stream: BROADCAST_STREAM, username: business.sourceKey, password: secret }); webhookOutcome = 'created'; }
      await store.record(token, ws, 'webhook', webhookOutcome, { webhookId: webhook.id });

      // 5. Domain.
      await intend('domain');
      const wanted = state.domain;
      let domain: PostmarkDomain | null = null, domainOutcome: StepOutcome = 'adopted';
      if (state.domainId) {
        domain = await account.getDomain(state.domainId).catch(error => {
          if (error instanceof PostmarkAccountError && (error.category === 'not_found' || error.errorCode === POSTMARK_CODES.domainNotFound)) return null;
          throw error;
        });
        if (domain && domain.name !== wanted) domain = null;
      }
      // A domain of that name already in the shared account is adopted ONLY when this business owns it: its id is on
      // our own row, or this business's earlier run started creating it (and was not told it was someone else's).
      // Anything else belongs to another business and is never shared. Looked for before creating, and again on 512.
      const adoptable = async (): Promise<PostmarkDomain | null> => {
        const found = (await account.listDomains()).find(item => item.name === wanted);
        if (!found) return null;
        if (!(state.domainId === found.id || state.domainAttempted)) throw new StepFailure('domain_taken', EMAIL_CONNECTION_MESSAGES.domainTaken);
        return account.getDomain(found.id);
      };
      if (!domain) domain = await adoptable();
      if (!domain) {
        try { domain = await account.createDomain({ name: wanted, returnPathDomain: `pm-bounces.${wanted}` }); domainOutcome = 'created'; }
        catch (error) {
          if (!(error instanceof PostmarkAccountError && error.errorCode === POSTMARK_CODES.domainExists)) throw error;
          domain = await adoptable();
          if (!domain) throw new StepFailure('domain_taken', EMAIL_CONNECTION_MESSAGES.domainTaken);
        }
      }
      await store.record(token, ws, 'domain', domainOutcome, { domainId: domain.id, dns: recordsOf(domain) });
      this.log(JSON.stringify({ event: 'email.connections.records_waiting', workspace: ws.slice(0, 8) }));
      return { ok: true, message: EMAIL_CONNECTION_MESSAGES.started };
    } catch (error) {
      if (error instanceof EmailConnectionError) throw error;
      if (error instanceof EmailConnectionForbiddenError) throw this.storeError(error);
      const failure = failureOf(error, state.domain);
      // Logged with the step and the Postmark status and code only; never a token, a secret or Postmark's text.
      this.log(JSON.stringify({ event: 'email.connections.step_failed', level: 'warn', step, outcome: failure.outcome,
        ...(error instanceof PostmarkAccountError ? { status: error.status, code: error.errorCode } : {}) }));
      if (failure.outcome === 'unauthorized') this.log(JSON.stringify({ event: 'email.connections.account_token_refused', level: 'warn',
        message: 'Postmark refused POSTMARK_ACCOUNT_TOKEN; Connect email cannot work until it is corrected.' }));
      await store.record(token, ws, step, failure.outcome).catch(() => this.log(JSON.stringify({ event: 'email.connections.record_failed', level: 'warn', step })));
      throw new EmailConnectionError(failure.outcome === 'busy' ? 503 : 409, failure.ownerMessage, failure.outcome);
    }
  }

  /** "Check": Postmark verifies both records; its answer is stored; our look-ups only choose the message. */
  async check(identity: PortalSessionIdentity): Promise<EmailConnectionResult> {
    if (!this.enabled) throw new EmailConnectionError(404, EMAIL_CONNECTION_MESSAGES.off, 'off');
    const business = this.business(identity), account = this.account!;
    return this.locked(business, async () => {
      const state = await this.read(identity, business);
      if ((state.status !== 'dns_pending' && state.status !== 'verified') || !state.domainId) return { ok: false, message: EMAIL_CONNECTION_MESSAGES.nothingToCheck };
      let dkim: PostmarkDomain, returnPath: PostmarkDomain;
      try {
        dkim = await account.verifyDkim(state.domainId);
        returnPath = await account.verifyReturnPath(state.domainId);
      } catch (error) {
        const failure = failureOf(error);
        this.log(JSON.stringify({ event: 'email.connections.check_failed', level: 'warn', outcome: failure.outcome,
          ...(error instanceof PostmarkAccountError ? { status: error.status, code: error.errorCode } : {}) }));
        throw new EmailConnectionError(503, failure.outcome === 'unauthorized' ? EMAIL_CONNECTION_MESSAGES.off : EMAIL_CONNECTION_MESSAGES.busy, failure.outcome);
      }
      const dkimOk = dkim.dkimVerified, returnPathOk = returnPath.returnPathVerified;
      const dns: EmailConnectionDns = Object.freeze({
        dkim: Object.freeze({ host: dkim.dkimHost || state.dns?.dkim.host || '', value: dkim.dkimValue || state.dns?.dkim.value || '', verified: dkimOk }),
        returnPath: Object.freeze({ host: returnPath.returnPathHost || state.dns?.returnPath.host || '', value: returnPath.returnPathValue || state.dns?.returnPath.value || '', verified: returnPathOk }),
      });
      try { await this.input.store.checked(identity.sessionToken, business.workspaceId, dns, dkimOk, returnPathOk); }
      catch (error) { throw this.storeError(error); }
      if (dkimOk && returnPathOk) return { ok: true, message: EMAIL_CONNECTION_MESSAGES.checkBoth };
      // Our own look-ups, only for the wording: is the missing record absent, or there with another value?
      const seen: { txt: DnsSeen | null; cname: DnsSeen | null } = {
        txt: dkimOk ? null : await lookUpTxt(this.resolver, dns.dkim.host, dns.dkim.value),
        cname: returnPathOk ? null : await lookUpCname(this.resolver, dns.returnPath.host, dns.returnPath.value),
      };
      if (seen.txt === 'different' || seen.cname === 'different') return { ok: false, message: EMAIL_CONNECTION_MESSAGES.checkMismatch };
      if (dkimOk || returnPathOk) return { ok: false, message: EMAIL_CONNECTION_MESSAGES.checkOne(dkimOk ? 'CNAME' : 'TXT') };
      return { ok: false, message: EMAIL_CONNECTION_MESSAGES.checkNone };
    });
  }

  /**
   * "Disconnect": the webhook is deleted at Postmark first, then the connection is marked disconnected and BOTH sealed
   * values are forgotten (the server token can be read again with the account token when the owner reconnects, and a
   * new webhook secret is made then). The Postmark server and domain are kept and their ids stay saved, so a later
   * Connect adopts them and the DNS records already added keep working.
   */
  async disconnect(identity: PortalSessionIdentity): Promise<EmailConnectionResult> {
    if (!this.enabled) throw new EmailConnectionError(404, EMAIL_CONNECTION_MESSAGES.off, 'off');
    const business = this.business(identity), config = this.input.config;
    if (!config.enabled) throw new EmailConnectionError(404, EMAIL_CONNECTION_MESSAGES.off, 'off');
    return this.locked(business, async () => {
      const state = await this.read(identity, business);
      if (state.status === 'not_connected' || state.status === 'disconnected') return { ok: true, message: EMAIL_CONNECTION_MESSAGES.disconnected };
      try {
        const sealed = await this.input.store.sealed(identity.sessionToken, business.workspaceId);
        if (state.webhookId && sealed.serverToken) {
          await this.serverApi(config.vault.open(business.workspaceId, 'server_token', sealed.serverToken)).deleteWebhook(state.webhookId).catch(error => {
            if (!(error instanceof PostmarkAccountError && (error.category === 'not_found' || error.errorCode === POSTMARK_CODES.webhookNotFound))) throw error;
          });
        }
        await this.input.store.disconnect(identity.sessionToken, business.workspaceId);
      } catch (error) {
        if (error instanceof PostmarkAccountError) {
          this.log(JSON.stringify({ event: 'email.connections.disconnect_failed', level: 'warn', status: error.status, code: error.errorCode }));
          throw new EmailConnectionError(503, EMAIL_CONNECTION_MESSAGES.busy, 'busy');
        }
        throw this.storeError(error);
      }
      this.input.bounces?.remove(business.workspaceId);
      return { ok: true, message: EMAIL_CONNECTION_MESSAGES.disconnected };
    });
  }
}
