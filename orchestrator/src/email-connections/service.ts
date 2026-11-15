/**
 * "Connect email": the state machine behind the owner's screens.
 *
 * Connect (and Continue) run under one lock per business, across every instance (taken only after the owner check,
 * so a stranger never queues behind an owner). Each step writes its intent first, then FINDS before it CREATES, so a
 * run interrupted anywhere is adopted on Continue and a double press creates nothing twice:
 *   1. server   "Relaunch72 - <business> - <workspace id>": the stored id, else a server of exactly that name, else
 *               a new one (603 "name exists" is adopted the same way). Its token is sealed and saved.
 *   2. stream   the Broadcast stream "broadcast": listed first, created only when missing (1230 is adopted unless the
 *               stream is archived).
 *   3. secret   the saved webhook secret, or (none saved, or it cannot be opened with today's key) a fresh 32-byte one,
 *               sealed and SAVED before the webhook is created; the bounce source is put in force in this process, so
 *               Postmark's set-up samples are answered.
 *   4. webhook  bounces, spam reports and subscription changes on that stream, at
 *               <portal origin>/api/provider-webhooks/postmark/<source key>, Basic user = source key. One already there
 *               for our address, with our secret and verified by Postmark, is adopted; any other at our address is
 *               replaced.
 *   5. domain   see DOMAIN ADOPTION below.
 * Then the connection waits for the two DNS records ('dns_pending'). "Check" asks Postmark to verify both and stores
 * Postmark's answer; our own DNS look-ups only choose the clearest message.
 *
 * DOMAIN ADOPTION (one sending domain per business, never shared). Every business sends through one shared Postmark
 * account, so a domain of the owner's name may already be there and belong to someone else. A domain is used when:
 *   a. its id is the one already saved on this business's own row (verified or not); or
 *   b. it was found by name AND Postmark shows BOTH its records unverified AND this business's own earlier run had
 *      started creating exactly that domain. "Started" (the domain step's intent) is written only after a fresh list
 *      of the account showed no domain of that name, immediately before the create call, so it means "we sent the
 *      create": it recovers a create whose answer was lost, and nothing else. A later "domain_taken" cancels it; or
 *   c. the platform founder, shown the clash, presses "Use this domain" (a hand-made set-up of the business's own
 *      domain). Who did it is in the events table; Postmark's current verified flags are read, never assumed.
 * Otherwise "domain_taken" is recorded (without any "started") and the owner is told plainly. A list that fails
 * stops the step before any intent is written, so no failure, restart or lost write can turn into adoption.
 *
 * A domain this business created that is still unverified on both records is deleted at Postmark when the owner
 * changes domain or disconnects, so unverified claims do not pile up. A verified one is kept.
 *
 * Nothing at Postmark is touched until the owner has agreed to the current email rules. Nothing here sends email:
 * the mode (off, test, live), the test and the protection live in email-protection/ (release 2, migration 0156).
 */
import { randomBytes } from 'node:crypto';
import type { PortalSessionIdentity } from '../portal/auth-service.js';
import { emailConnectBusiness, type EmailConnectBusiness, type EmailConnectConfig } from './config.js';
import { connectionBounceSource } from './bounce-sources.js';
import { freeMailboxDomain, lookUpCname, lookUpDnsHost, lookUpTxt, parseEmailAddress, publicSuffixOnly, reservedDomain, senderName, systemDnsResolver,
  type DnsHost, type DnsResolver, type DnsSeen } from './domains.js';
import { createPostmarkAccountApi, POSTMARK_CODES, PostmarkAccountError, type PostmarkAccountApi, type PostmarkDomain, type PostmarkServerApi } from './postmark-account-api.js';
import { EmailConnectionAbsentError, EmailConnectionForbiddenError, type DomainOrigin, type EmailConnectionDns, type EmailConnectionState, type EmailConnectionStep,
  type EmailConnectionStore, type RunLock, type StepOutcome } from './store.js';
import { EMAIL_TERMS_VERSION } from './terms.js';
import type { EmailBounceSource } from '../email-bounces/index.js';

export const BROADCAST_STREAM = 'broadcast';
const LOCK_WAIT_MS = 20_000;

/** Every sentence the owner can see from this service. Plain English; never a provider message, an id or a setting name. */
export const EMAIL_CONNECTION_MESSAGES = Object.freeze({
  freeMailbox: (domain: string) => `That's a free mailbox (${domain}). Use an address on your own domain.`,
  reservedDomain: 'That address can\'t receive email. Use an address on your own domain.',
  publicSuffix: 'That isn\'t a full domain. Use an address on your own domain, like hello@yourbusiness.co.uk.',
  domainTaken: 'That domain is already connected to another business.',
  domainInUse: 'That domain is already in use. If it is yours, contact support.',
  founderTakeOver: 'This domain is already in our email account. If it belongs to this business, press Use this domain.',
  busy: 'The email service is busy. Try again in a minute.',
  locked: 'This is already being set up in another window. Give it a moment, then refresh.',
  off: 'Email connection isn\'t switched on yet.',
  notAvailable: 'Email connection is not available right now.',
  awaitingApproval: 'Our email account is still being approved, so set-up is paused here. We will pick it up as soon as it is approved; press Continue later.',
  unfinished: 'We couldn\'t finish setting up. Press Continue.',
  interrupted: 'This was interrupted. Press Continue.',
  planLimit: 'Our email account has reached its limit for new businesses.',
  needsHand: 'Part of the email set-up needs a hand from us.',
  /** Added to a permanent failure only when its event really was written to the events table the platform owner reads. */
  logged: ' We have logged this and will sort it out.',
  tryLater: ' Please try again later.',
  wrongDomain: 'Something doesn\'t look right with this domain at the email service. Please contact support.',
  repaired: 'Your email connection was repaired. Press Check to confirm your records.',
  termsFirst: 'Tick the email rules first.',
  needName: 'Enter the sender name: up to 100 characters, without < > " or \\.',
  needFrom: 'Enter the address to send from, on your own domain, like hello@yourbusiness.co.uk.',
  needReplyTo: 'Enter a valid address for replies, or leave it empty.',
  alreadyConnected: 'Email is already connected for this business. Disconnect it first to use another address.',
  notOwner: 'Only an owner of this business can connect its email.',
  notAllowed: 'Email can only be connected for Property Predator for now.',
  nothingToContinue: 'There is nothing to continue yet. Fill in your sending address and press Connect.',
  checkBoth: 'Both found. Your email is connected.',
  checkOne: (kind: 'TXT' | 'CNAME') => `Found 1 of 2: the ${kind} record is missing.`,
  checkNone: 'Not found yet. This can take up to 48 hours; press Check again later.',
  checkMismatch: (kind: 'TXT' | 'CNAME') => `The ${kind} record's value doesn't match. Copy it again from this page.`,
  started: 'Nearly there. Add the 2 records below where your domain is managed, then press Check.',
  connectedNext: 'Connected. Sending is switched on in the next step.',
  disconnected: 'Email is disconnected. You can connect again at any time.',
  nothingToCheck: 'There is nothing to check yet.',
});

export class EmailConnectionError extends Error {
  override readonly name = 'EmailConnectionError';
  constructor(readonly status: number, message: string, readonly code: string) { super(message); }
}

export type EmailConnectionView =
  | { readonly offered: false; readonly message: string }
  | { readonly offered: true; readonly business: EmailConnectBusiness; readonly state: EmailConnectionState; readonly dnsHost: DnsHost | null;
      /** A connected business whose saved secrets cannot be opened (the key changed): Continue repairs it. */
      readonly repair?: boolean };

export interface EmailConnectionResult { readonly ok: boolean; readonly message: string }

export interface EmailConnectionBounceHook {
  apply(source: EmailBounceSource): void;
  remove(workspaceId: string): void;
}

/** The deterministic Postmark server name for a business: ASCII only, with the full workspace id. */
export const connectionServerName = (business: EmailConnectBusiness): string => `Relaunch72 - ${business.name} - ${business.workspaceId.replace(/-/gu, '')}`;
export const connectionWebhookUrl = (origin: string, business: EmailConnectBusiness): string => `${origin}/api/provider-webhooks/postmark/${business.sourceKey}`;
const recordsOf = (domain: PostmarkDomain, origin: DomainOrigin): EmailConnectionDns => Object.freeze({
  dkim: Object.freeze({ host: domain.dkimHost, value: domain.dkimValue, verified: domain.dkimVerified }),
  returnPath: Object.freeze({ host: domain.returnPathHost, value: domain.returnPathValue, verified: domain.returnPathVerified }),
  origin,
});
const missing = (error: unknown) => error instanceof PostmarkAccountError && (error.category === 'not_found' || error.errorCode === POSTMARK_CODES.domainNotFound
  || error.errorCode === POSTMARK_CODES.webhookNotFound);

class StepFailure extends Error {
  /** permanent: pressing Continue will not help; the owner is told it is logged only when the event was written. */
  constructor(readonly outcome: StepOutcome, readonly ownerMessage: string, readonly status = 409, readonly permanent = false) { super(outcome); }
}

/** What a Postmark failure means for the owner, and the code recorded for the step. Permanent ones never say "Continue". */
function failureOf(error: unknown, domain = 'that domain'): StepFailure {
  if (error instanceof StepFailure) return error;
  if (error instanceof PostmarkAccountError) {
    if (error.category === 'busy' || error.category === 'timeout' || error.category === 'network') return new StepFailure('busy', EMAIL_CONNECTION_MESSAGES.busy, 503);
    if (error.category === 'unauthorized') return new StepFailure('unauthorized', EMAIL_CONNECTION_MESSAGES.notAvailable, 503, true);
    if (error.errorCode === POSTMARK_CODES.pendingApproval || error.errorCode === POSTMARK_CODES.notApproved) return new StepFailure('awaiting_approval', EMAIL_CONNECTION_MESSAGES.awaitingApproval);
    if (error.errorCode === POSTMARK_CODES.limitReached) return new StepFailure('plan_limit', EMAIL_CONNECTION_MESSAGES.planLimit, 409, true);
    if (error.errorCode === POSTMARK_CODES.publicDomain) return new StepFailure('public_domain', EMAIL_CONNECTION_MESSAGES.freeMailbox(domain), 400);
    if (error.errorCode === POSTMARK_CODES.webhookVerificationFailed) return new StepFailure('refused', EMAIL_CONNECTION_MESSAGES.unfinished);
    return new StepFailure('refused', EMAIL_CONNECTION_MESSAGES.needsHand, 409, true);
  }
  return new StepFailure('failed', EMAIL_CONNECTION_MESSAGES.unfinished);
}

export class EmailConnectionService {
  private readonly account: PostmarkAccountApi | null;
  private readonly serverApi: (token: string) => PostmarkServerApi;
  private readonly resolver: DnsResolver;
  private readonly log: (line: string) => void;
  private readonly secret: () => string;
  /** Runs in progress in THIS process, by workspace: a second window for the same business is told at once. */
  private readonly inFlight = new Set<string>();

  constructor(private readonly input: {
    config: EmailConnectConfig;
    store: EmailConnectionStore;
    account?: PostmarkAccountApi;
    resolver?: DnsResolver;
    bounces?: EmailConnectionBounceHook;
    log?: (line: string) => void;
    /** Whether this signed-in person is the platform founder (the limits page's own check). Absent: nobody is. */
    founder?: (identity: PortalSessionIdentity) => Promise<boolean>;
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

  /** The configuration allows the feature (the database may still lack 0155: see available()). */
  get enabled(): boolean { return this.input.config.enabled && this.account !== null; }

  /** On, AND the database has 0155: only then is any entry to the page shown. Never throws. */
  async available(): Promise<boolean> { return this.enabled && await this.input.store.present().catch(() => false); }

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

  private async isFounder(identity: PortalSessionIdentity): Promise<boolean> {
    try { return (await this.input.founder?.(identity)) === true; } catch { return false; }
  }

  /** What the page shows. Never throws for "not switched on": that is a page of its own. */
  async view(identity: PortalSessionIdentity): Promise<EmailConnectionView> {
    if (!this.enabled) return { offered: false, message: EMAIL_CONNECTION_MESSAGES.off };
    const business = this.business(identity);
    let state: EmailConnectionState;
    try { state = await this.read(identity, business); }
    catch (error) { if (error instanceof EmailConnectionError && error.code === 'off') return { offered: false, message: EMAIL_CONNECTION_MESSAGES.off }; throw error; }
    const dnsHost = state.status === 'dns_pending' && state.domain ? await lookUpDnsHost(this.resolver, state.domain) : null;
    const repair = await this.repairNeeded(identity, business, state).catch(() => false);
    return { offered: true, business, state, dnsHost, ...(repair ? { repair } : {}) };
  }

  /** The owner check runs first (a database read with the session); only then is the business's run lock taken. */
  private async locked<T>(identity: PortalSessionIdentity, work: (business: EmailConnectBusiness, lock: RunLock) => Promise<T>): Promise<T> {
    if (!this.enabled) throw new EmailConnectionError(404, EMAIL_CONNECTION_MESSAGES.off, 'off');
    const business = this.business(identity);
    await this.read(identity, business);
    // The same business already running in this process: said at once, without queueing on the lock's connection.
    if (this.inFlight.has(business.workspaceId)) throw new EmailConnectionError(409, EMAIL_CONNECTION_MESSAGES.locked, 'locked');
    this.inFlight.add(business.workspaceId);
    try {
      let lock: RunLock | null;
      // Another instance may hold it: waited for up to the deadline.
      try { lock = await this.input.store.lock(business.workspaceId, this.input.lockWaitMs ?? LOCK_WAIT_MS); }
      catch (error) { throw this.storeError(error); }
      if (!lock) throw new EmailConnectionError(409, EMAIL_CONNECTION_MESSAGES.locked, 'locked');
      try { return await work(business, lock); } finally { await lock.release(); }
    } finally { this.inFlight.delete(business.workspaceId); }
  }

  /** Whether another business's connection row holds this domain; when that cannot be told, assumed yes (refuse). */
  private async heldElsewhere(workspaceId: string, domain: { id: number | null; name: string }): Promise<boolean> {
    try { return await this.input.store.otherConnectionHolds(workspaceId, domain); } catch { return true; }
  }

  /** The Return-Path host that proves THIS business created a domain with today's key (see vault.returnPathLabel). */
  private proofHost(workspaceId: string, domain: string): string {
    const config = this.input.config;
    if (!config.enabled) throw new EmailConnectionError(404, EMAIL_CONNECTION_MESSAGES.off, 'off');
    return `${config.vault.returnPathLabel(workspaceId, domain)}.${domain}`;
  }

  /**
   * Deletes the domain at Postmark when this business created it and Postmark still shows both records unverified.
   * A verified domain, or one adopted or taken over, is always kept. Never throws: the outcome is logged (and recorded
   * as an event while the connection is being set up).
   */
  private async releaseUnverifiedDomain(identity: PortalSessionIdentity, business: EmailConnectBusiness, state: EmailConnectionState): Promise<void> {
    if (!state.domainId || state.dns?.origin !== 'created') return;
    let outcome: 'domain_removed' | 'domain_kept' | 'domain_gone' | 'domain_remove_failed';
    try {
      const domain = await this.account!.getDomain(state.domainId).catch(error => { if (missing(error)) return null; throw error; });
      // Deleted only when it still carries THIS business's proof (so it is certainly the one we created), both records are
      // unverified, and no other business's connection holds it.
      if (!domain) outcome = 'domain_gone';
      else if (domain.dkimVerified || domain.returnPathVerified || domain.name !== state.domain || !state.domain
        || domain.returnPathHost !== this.proofHost(business.workspaceId, state.domain)
        || await this.heldElsewhere(business.workspaceId, { id: domain.id, name: domain.name })) outcome = 'domain_kept';
      else { await this.account!.deleteDomain(state.domainId); outcome = 'domain_removed'; }
    } catch { outcome = 'domain_remove_failed'; }
    this.log(JSON.stringify({ event: 'email.connections.unverified_domain', level: outcome === 'domain_remove_failed' ? 'warn' : 'info', outcome, workspace: business.workspaceId.slice(0, 8) }));
    if (state.status === 'creating' || state.status === 'needs_attention') {
      await this.input.store.record(identity.sessionToken, business.workspaceId, 'domain', outcome).catch(() => undefined);
    }
  }

  /** "Connect": validates, records the agreement to the rules, saves the details, then runs the steps. */
  async connect(identity: PortalSessionIdentity, form: { fromName: string; fromAddress: string; replyTo: string; agreed: boolean }): Promise<EmailConnectionResult> {
    if (!this.enabled) throw new EmailConnectionError(404, EMAIL_CONNECTION_MESSAGES.off, 'off');
    this.business(identity);
    const fromName = senderName(form.fromName);
    if (!fromName) throw new EmailConnectionError(400, EMAIL_CONNECTION_MESSAGES.needName, 'name');
    const from = parseEmailAddress(form.fromAddress);
    if (!from) throw new EmailConnectionError(400, EMAIL_CONNECTION_MESSAGES.needFrom, 'from');
    // Refused before Postmark is ever called.
    if (publicSuffixOnly(from.domain)) throw new EmailConnectionError(400, EMAIL_CONNECTION_MESSAGES.publicSuffix, 'public_suffix');
    if (freeMailboxDomain(from.domain)) throw new EmailConnectionError(400, EMAIL_CONNECTION_MESSAGES.freeMailbox(from.domain), 'free_mailbox');
    if (reservedDomain(from.domain)) throw new EmailConnectionError(400, EMAIL_CONNECTION_MESSAGES.reservedDomain, 'reserved');
    const replyTo = form.replyTo.trim() ? parseEmailAddress(form.replyTo) : null;
    if (form.replyTo.trim() && (!replyTo || reservedDomain(replyTo.domain))) throw new EmailConnectionError(400, EMAIL_CONNECTION_MESSAGES.needReplyTo, 'reply_to');
    // The rules are agreed to on the server; an unticked box changes nothing at all.
    if (!form.agreed) throw new EmailConnectionError(400, EMAIL_CONNECTION_MESSAGES.termsFirst, 'terms');
    return this.locked(identity, async (business, lock) => {
      const before = await this.read(identity, business);
      // A different domain while not connected: this business's own unverified domain is released first.
      if (before.domain && before.domain !== from.domain && before.status !== 'dns_pending' && before.status !== 'verified') {
        await this.releaseUnverifiedDomain(identity, business, before);
      }
      let begun;
      try {
        await this.input.store.acceptTerms(identity.sessionToken, business.workspaceId, EMAIL_TERMS_VERSION);
        begun = await this.input.store.begin(identity.sessionToken, business.workspaceId,
          { domain: from.domain, fromName, fromAddress: from.address, replyTo: replyTo?.address ?? null }, EMAIL_TERMS_VERSION);
      } catch (error) { throw this.storeError(error); }
      if (begun === 'terms_required') throw new EmailConnectionError(409, EMAIL_CONNECTION_MESSAGES.termsFirst, 'terms');
      if (begun === 'domain_taken') throw new EmailConnectionError(409, EMAIL_CONNECTION_MESSAGES.domainTaken, 'domain_taken');
      if (begun === 'already_connected') throw new EmailConnectionError(409, EMAIL_CONNECTION_MESSAGES.alreadyConnected, 'already_connected');
      return this.run(identity, business, false, lock);
    });
  }

  /** "Continue" after an interruption: the same steps on the saved details, adopting whatever already exists. */
  async continue(identity: PortalSessionIdentity): Promise<EmailConnectionResult> {
    return this.locked(identity, async (business, lock) => {
      const state = await this.read(identity, business);
      if (state.status === 'creating' || state.status === 'needs_attention') return this.run(identity, business, false, lock);
      if (await this.repairNeeded(identity, business, state)) return this.repair(identity, business, state, lock);
      if (state.status === 'verified') return { ok: true, message: EMAIL_CONNECTION_MESSAGES.connectedNext };
      if (state.status === 'dns_pending') return { ok: true, message: EMAIL_CONNECTION_MESSAGES.started };
      return { ok: false, message: EMAIL_CONNECTION_MESSAGES.nothingToContinue };
    });
  }

  /** The founder's "Use this domain": takes over the domain of this name already in the account, for this business. */
  async useExistingDomain(identity: PortalSessionIdentity): Promise<EmailConnectionResult> {
    if (!this.enabled) throw new EmailConnectionError(404, EMAIL_CONNECTION_MESSAGES.off, 'off');
    if (!(await this.isFounder(identity))) throw new EmailConnectionError(403, EMAIL_CONNECTION_MESSAGES.domainInUse, 'not_founder');
    return this.locked(identity, async (business, lock) => {
      const state = await this.read(identity, business);
      if (state.status !== 'creating' && state.status !== 'needs_attention') return { ok: false, message: EMAIL_CONNECTION_MESSAGES.nothingToContinue };
      return this.run(identity, business, true, lock);
    });
  }

  private async run(identity: PortalSessionIdentity, business: EmailConnectBusiness, takeOver: boolean, lock: RunLock): Promise<EmailConnectionResult> {
    const { store } = this.input, token = identity.sessionToken, ws = business.workspaceId;
    const config = this.input.config;
    if (!config.enabled) throw new EmailConnectionError(404, EMAIL_CONNECTION_MESSAGES.off, 'off');
    const account = this.account!;
    const state = await this.read(identity, business);
    // The rules must be agreed to for the CURRENT version before any Postmark call, on Continue too.
    if (state.terms?.version !== EMAIL_TERMS_VERSION) throw new EmailConnectionError(409, EMAIL_CONNECTION_MESSAGES.termsFirst, 'terms');
    if (!state.domain) throw new EmailConnectionError(409, EMAIL_CONNECTION_MESSAGES.nothingToContinue, 'no_details');
    let step: EmailConnectionStep = 'server';
    // Every step checks the run lock is still held; a lost lock stops the run here instead of carrying on unlocked.
    const intend = async (next: EmailConnectionStep) => {
      step = next;
      if (lock.lost()) throw new StepFailure('failed', EMAIL_CONNECTION_MESSAGES.interrupted);
      await store.intend(token, ws, next);
    };
    try {
      // 1. Server.
      await intend('server');
      const name = connectionServerName(business);
      let server = state.serverId ? await account.getServer(state.serverId).catch(error => { if (missing(error)) return null; throw error; }) : null;
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
          // An archived stream of that name cannot be used; that needs a person, not another press.
          if (!again || again.archived) throw new StepFailure('refused', EMAIL_CONNECTION_MESSAGES.needsHand, 409, true);
        }
      }
      await store.record(token, ws, 'stream', streamOutcome, { stream: BROADCAST_STREAM });

      // 3. Webhook secret: saved before the webhook exists, and put in force here so Postmark's samples are answered.
      await intend('secret');
      const sealed = await store.sealed(token, ws);
      let secret: string | null = null;
      if (sealed.webhookSecret) {
        // A secret sealed under a lost or changed key is treated as absent: a new one is made and the webhook replaced.
        try { secret = config.vault.open(ws, 'webhook_secret', sealed.webhookSecret); } catch { secret = null; }
      }
      if (!secret) {
        secret = this.secret();
        await store.saveSealed(token, ws, 'webhook_secret', config.vault.seal(ws, 'webhook_secret', secret));
      }
      this.input.bounces?.apply(connectionBounceSource({ workspaceId: ws, serverId: String(server.id), stream: BROADCAST_STREAM, serverToken, webhookSecret: secret }));

      // 4. Webhook.
      await intend('webhook');
      const url = connectionWebhookUrl(config.webhookOrigin, business);
      const existing = (await serverApi.listWebhooks(BROADCAST_STREAM)).filter(hook => hook.url === url);
      let webhook = existing.find(hook => hook.username === business.sourceKey && hook.password === secret && hook.status === 'verified') ?? null;
      // Ours by address but with another secret, or marked unverified by Postmark: replaced, never adopted.
      for (const stale of existing) if (stale !== webhook) await serverApi.deleteWebhook(stale.id).catch(error => { if (!missing(error)) throw error; });
      let webhookOutcome: StepOutcome = 'adopted';
      if (!webhook) { webhook = await serverApi.createWebhook({ url, stream: BROADCAST_STREAM, username: business.sourceKey, password: secret }); webhookOutcome = 'created'; }
      await store.record(token, ws, 'webhook', webhookOutcome, { webhookId: webhook.id });

      // 5. Domain (see DOMAIN ADOPTION above). The account is listed BEFORE any intent is written; a failed list is
      // recorded under this step.
      step = 'domain';
      const wanted = state.domain, proof = this.proofHost(ws, wanted);
      const proven = (d: PostmarkDomain) => d.name === wanted && d.returnPathHost === proof;
      let domain: PostmarkDomain | null = null, origin: DomainOrigin = 'adopted', domainOutcome: StepOutcome = 'adopted';
      if (state.domainId) {
        // By the id on our own row. 'created' only when it carries our proof; a taken-over domain stays taken over.
        domain = await account.getDomain(state.domainId).catch(error => { if (missing(error)) return null; throw error; });
        if (domain && domain.name !== wanted) domain = null;
        if (domain) origin = proven(domain) ? 'created' : state.dns?.origin === 'taken_over' ? 'taken_over' : 'adopted';
      }
      const taken = async (offerTakeOver: boolean): Promise<never> => {
        // Even when this write is lost, nothing was adopted: the next run lists again and checks the proof again.
        await store.record(token, ws, 'domain', 'domain_taken').catch(() => this.log(JSON.stringify({ event: 'email.connections.record_failed', level: 'warn', step: 'domain' })));
        const founder = offerTakeOver && await this.isFounder(identity);
        this.log(JSON.stringify({ event: 'email.connections.domain_in_account', level: 'warn', workspace: ws.slice(0, 8), founder }));
        throw founder ? new EmailConnectionError(409, EMAIL_CONNECTION_MESSAGES.founderTakeOver, 'domain_in_account')
          : new EmailConnectionError(409, EMAIL_CONNECTION_MESSAGES.domainInUse, 'domain_in_use');
      };
      if (!domain) {
        const found = (await account.listDomains()).find(item => item.name === wanted);
        if (found) {
          const details = await account.getDomain(found.id);
          const elsewhere = await this.heldElsewhere(ws, { id: details.id, name: details.name });
          if (details.name !== wanted || elsewhere) await taken(false);
          // Our own create whose answer was lost: it carries our proof and nobody has verified it.
          if (proven(details) && !details.dkimVerified && !details.returnPathVerified) { domain = details; origin = 'created'; }
          else if (takeOver) {
            // The founder's decision, recorded (with who) before the domain is saved for this business.
            await store.record(token, ws, 'domain', 'founder_takeover');
            domain = details; origin = 'taken_over';
            this.log(JSON.stringify({ event: 'email.connections.domain_taken_over', level: 'warn', workspace: ws.slice(0, 8) }));
          } else await taken(true);
        }
      }
      await intend('domain');
      if (!domain) {
        let created: PostmarkDomain;
        try { created = await account.createDomain({ name: wanted, returnPathDomain: proof }); }
        catch (error) {
          // It appeared between our list and our create: someone else's. Never adopted.
          if (error instanceof PostmarkAccountError && error.errorCode === POSTMARK_CODES.domainExists) await taken(true);
          throw error;
        }
        // The answer must be the domain we asked for, carrying our proof; anything else is never saved.
        if (!proven(created)) throw new StepFailure('refused', EMAIL_CONNECTION_MESSAGES.needsHand, 409, true);
        domain = created; domainOutcome = 'created'; origin = 'created';
      }
      if (lock.lost()) throw new StepFailure('failed', EMAIL_CONNECTION_MESSAGES.interrupted);
      await store.record(token, ws, 'domain', domainOutcome, { domainId: domain.id, dns: recordsOf(domain, origin) });
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
      const recorded = await store.record(token, ws, step, failure.outcome).then(() => true, () => { this.log(JSON.stringify({ event: 'email.connections.record_failed', level: 'warn', step })); return false; });
      // "We have logged this" only when the event the platform owner reads really was written.
      const message = failure.permanent ? failure.ownerMessage + (recorded ? EMAIL_CONNECTION_MESSAGES.logged : EMAIL_CONNECTION_MESSAGES.tryLater) : failure.ownerMessage;
      throw new EmailConnectionError(failure.status, message, failure.outcome);
    }
  }

  /** A connected (or waiting) business whose saved server token or webhook secret cannot be opened with today's key. */
  private async repairNeeded(identity: PortalSessionIdentity, business: EmailConnectBusiness, state: EmailConnectionState): Promise<boolean> {
    const config = this.input.config;
    if (!config.enabled || (state.status !== 'dns_pending' && state.status !== 'verified')) return false;
    const sealed = await this.input.store.sealed(identity.sessionToken, business.workspaceId);
    if (!sealed.serverToken || !sealed.webhookSecret) return true;
    try { config.vault.open(business.workspaceId, 'server_token', sealed.serverToken); config.vault.open(business.workspaceId, 'webhook_secret', sealed.webhookSecret); return false; }
    catch { return true; }
  }

  /**
   * Remakes the webhook secret and the webhook for a connected business whose saved secrets no longer open. 0155 lets
   * secrets be saved only while setting up, so the connection is set back to "setting up" with the SAME details (the
   * server, stream and domain are adopted by id; nothing is deleted except our old webhook), then the steps run again:
   * one webhook at our address afterwards, with a new secret. Postmark's verified flags are read again by Check.
   */
  private async repair(identity: PortalSessionIdentity, business: EmailConnectBusiness, state: EmailConnectionState, lock: RunLock): Promise<EmailConnectionResult> {
    const { store } = this.input, token = identity.sessionToken, ws = business.workspaceId;
    if (state.terms?.version !== EMAIL_TERMS_VERSION) throw new EmailConnectionError(409, EMAIL_CONNECTION_MESSAGES.termsFirst, 'terms');
    if (!state.domain || !state.fromName || !state.fromAddress) throw new EmailConnectionError(409, EMAIL_CONNECTION_MESSAGES.nothingToContinue, 'no_details');
    this.log(JSON.stringify({ event: 'email.connections.repair', level: 'warn', workspace: ws.slice(0, 8),
      message: 'Saved email connection secrets could not be opened with EMAIL_CONNECTION_KEY; the webhook secret and webhook are being remade.' }));
    try {
      await store.disconnect(token, ws);
      const begun = await store.begin(token, ws, { domain: state.domain, fromName: state.fromName, fromAddress: state.fromAddress, replyTo: state.replyTo }, EMAIL_TERMS_VERSION);
      if (begun !== 'started') throw new EmailConnectionError(409, EMAIL_CONNECTION_MESSAGES.unfinished, 'repair');
    } catch (error) { throw this.storeError(error); }
    // The stale webhook (secret we can no longer read) is found at our address and replaced by run().
    await this.run(identity, business, false, lock);
    return { ok: true, message: EMAIL_CONNECTION_MESSAGES.repaired };
  }

  /** "Check": Postmark verifies both records; its answer is stored; our look-ups only choose the message. */
  async check(identity: PortalSessionIdentity): Promise<EmailConnectionResult> {
    return this.locked(identity, async (business, lock) => {
      const account = this.account!;
      const state = await this.read(identity, business);
      if ((state.status !== 'dns_pending' && state.status !== 'verified') || !state.domainId || !state.domain) return { ok: false, message: EMAIL_CONNECTION_MESSAGES.nothingToCheck };
      if (state.terms?.version !== EMAIL_TERMS_VERSION) throw new EmailConnectionError(409, EMAIL_CONNECTION_MESSAGES.termsFirst, 'terms');
      // Secrets that no longer open (the key changed): the webhook is remade first, so the check answers truly.
      if (await this.repairNeeded(identity, business, state)) await this.repair(identity, business, state, lock);
      let dkim: PostmarkDomain, returnPath: PostmarkDomain;
      try {
        dkim = await account.verifyDkim(state.domainId);
        returnPath = await account.verifyReturnPath(state.domainId);
      } catch (error) {
        const failure = failureOf(error);
        this.log(JSON.stringify({ event: 'email.connections.check_failed', level: 'warn', outcome: failure.outcome,
          ...(error instanceof PostmarkAccountError ? { status: error.status, code: error.errorCode } : {}) }));
        throw new EmailConnectionError(503, failure.outcome === 'unauthorized' ? EMAIL_CONNECTION_MESSAGES.notAvailable + EMAIL_CONNECTION_MESSAGES.tryLater : EMAIL_CONNECTION_MESSAGES.busy, failure.outcome);
      }
      // The answer must be about this business's own domain.
      if (dkim.name !== state.domain || returnPath.name !== state.domain) {
        this.log(JSON.stringify({ event: 'email.connections.check_wrong_domain', level: 'warn', workspace: business.workspaceId.slice(0, 8) }));
        throw new EmailConnectionError(409, EMAIL_CONNECTION_MESSAGES.wrongDomain, 'wrong_domain');
      }
      const dkimOk = dkim.dkimVerified, returnPathOk = returnPath.returnPathVerified;
      const dns: EmailConnectionDns = Object.freeze({
        dkim: Object.freeze({ host: dkim.dkimHost || state.dns?.dkim.host || '', value: dkim.dkimValue || state.dns?.dkim.value || '', verified: dkimOk }),
        returnPath: Object.freeze({ host: returnPath.returnPathHost || state.dns?.returnPath.host || '', value: returnPath.returnPathValue || state.dns?.returnPath.value || '', verified: returnPathOk }),
        origin: state.dns?.origin ?? 'adopted',
      });
      try { await this.input.store.checked(identity.sessionToken, business.workspaceId, dns, dkimOk, returnPathOk); }
      catch (error) { throw this.storeError(error); }
      if (dkimOk && returnPathOk) return { ok: true, message: EMAIL_CONNECTION_MESSAGES.checkBoth };
      // Our own look-ups, only for the wording: is the missing record absent, or there with another value?
      const seen: { txt: DnsSeen | null; cname: DnsSeen | null } = {
        txt: dkimOk ? null : await lookUpTxt(this.resolver, dns.dkim.host, dns.dkim.value),
        cname: returnPathOk ? null : await lookUpCname(this.resolver, dns.returnPath.host, dns.returnPath.value),
      };
      if (seen.txt === 'different') return { ok: false, message: EMAIL_CONNECTION_MESSAGES.checkMismatch('TXT') };
      if (seen.cname === 'different') return { ok: false, message: EMAIL_CONNECTION_MESSAGES.checkMismatch('CNAME') };
      if (dkimOk || returnPathOk) return { ok: false, message: EMAIL_CONNECTION_MESSAGES.checkOne(dkimOk ? 'CNAME' : 'TXT') };
      return { ok: false, message: EMAIL_CONNECTION_MESSAGES.checkNone };
    });
  }

  /**
   * "Disconnect" (and "Start again"): the webhook is deleted at Postmark first (the server token is read again from the
   * account if the saved one cannot be opened), this business's still-unverified domain is released, then the
   * connection is marked disconnected and BOTH sealed values are forgotten. The Postmark server, and a verified domain,
   * are kept with their ids saved, so a later Connect adopts them.
   */
  async disconnect(identity: PortalSessionIdentity): Promise<EmailConnectionResult> {
    return this.locked(identity, async (business, lock) => {
      const config = this.input.config;
      if (!config.enabled) throw new EmailConnectionError(404, EMAIL_CONNECTION_MESSAGES.off, 'off');
      const state = await this.read(identity, business);
      if (state.status === 'not_connected' || state.status === 'disconnected') return { ok: true, message: EMAIL_CONNECTION_MESSAGES.disconnected };
      try {
        if (state.webhookId) {
          const sealed = await this.input.store.sealed(identity.sessionToken, business.workspaceId);
          let token: string | null = null;
          if (sealed.serverToken) { try { token = config.vault.open(business.workspaceId, 'server_token', sealed.serverToken); } catch { token = null; } }
          if (!token && state.serverId) token = (await this.account!.getServer(state.serverId).catch(error => { if (missing(error)) return null; throw error; }))?.serverToken ?? null;
          if (token) await this.serverApi(token).deleteWebhook(state.webhookId).catch(error => { if (!missing(error)) throw error; });
        }
        await this.releaseUnverifiedDomain(identity, business, state);
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
