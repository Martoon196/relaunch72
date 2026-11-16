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
import { confirmBounceWebhook, sameWebhookAddress, webhookCheckLine } from './webhook-check.js';

export const BROADCAST_STREAM = 'broadcast';
const LOCK_WAIT_MS = 20_000;

/** Every sentence the owner can see from this service. Plain English; never a provider message, an id or a setting name. */
export const EMAIL_CONNECTION_MESSAGES = Object.freeze({
  freeMailbox: (domain: string) => `That's a free mailbox (${domain}). Use an address on your own domain.`,
  reservedDomain: 'That address can\'t receive email. Use an address on your own domain.',
  publicSuffix: 'That isn\'t a full domain. Use an address on your own domain, like hello@yourbusiness.co.uk.',
  domainTaken: 'That domain is already connected to another business.',
  domainInUse: 'That domain is already used in our email account, so it can\'t be connected from here. Use an address on a different domain, or tell the platform owner if it is yours.',
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
  wrongDomain: 'Something doesn\'t look right with this domain at the email service. Nothing was changed. Please tell the platform owner.',
  repaired: 'Your email connection was repaired. Press Check to confirm your records.',
  termsFirst: 'Tick the email rules first.',
  needName: 'Enter the sender name: up to 100 characters, without < > " or \\.',
  needFrom: 'Enter the address to send from, on your own domain, like hello@yourbusiness.co.uk.',
  needReplyTo: 'Enter a valid address for replies, or leave it empty.',
  alreadyConnected: 'Email is already connected for this business. To use another address, press Start again (or Disconnect, once connected) under More options first.',
  notOwner: 'Only an owner of this business can connect its email.',
  notAllowed: 'Email can only be connected for Property Predator for now.',
  nothingToContinue: 'There is nothing to continue yet. Start with step 1 below.',
  checkBoth: 'Both found. Your email is connected.',
  checkOne: (kind: 'TXT' | 'CNAME') => `Found 1 of 2. Record ${kind === 'TXT' ? 1 : 2} is not found yet. Records can take from a few minutes to a few hours to show up; press Check again later.`,
  checkNone: 'Not found yet. Records can take from a few minutes to a few hours to show up after they are added (very rarely up to 2 days). You can close this page and come back; press Check again later.',
  checkMismatch: (kind: 'TXT' | 'CNAME') => `Record ${kind === 'TXT' ? 1 : 2} is there, but its Value doesn't match. Copy the Value again from this page and replace the old one.`,
  started: 'Nearly there. Add the two records below at the company that manages your domain (or send them to whoever looks after your website), then press Check.',
  startedFound: 'Nearly there. Both records are already in place for your domain, so press Check below to finish.',
  webhookUnreachable: 'The email service couldn\'t reach our bounce address while setting up. Press Continue in a minute.',
  bounceWorking: 'Bounce reporting is working. Press Go live again.',
  bounceRepaired: 'Bounce reporting is working again. Press Go live again.',
  bounceWorkingCheck: 'Bounce reporting is working. Press Check below to finish connecting.',
  bounceRemade: 'Bounce reporting was set up again. Press Check below to confirm your records; then follow the steps to send yourself a test and go live.',
  bounceRemadeLive: 'Bounce reporting was set up again. Press Check below to confirm your records, then send a test to yourself. Your marketing emails go out again once that test arrives.',
  bounceUnclear: 'We couldn\'t tell whether bounce reporting works now. Press Repair bounce reporting again in a minute.',
  bounceStillFailing: 'The email service still can\'t reach our bounce address. Press Repair bounce reporting again in a few minutes; if it keeps failing, tell the platform owner.',
  /** A repair whose new bounce webhook was not saved: the repair button stays (never "Continue", which is not on that screen). */
  bounceNotSaved: 'We couldn\'t finish setting up bounce reporting. Press Repair bounce reporting again in a minute.',
  /** The page's own once-a-minute check found secrets it cannot open: it never repairs by itself. */
  autoCheckNeedsRepair: 'Your email connection needs a repair before we can check. Press Repair.',
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

export interface EmailConnectionResult {
  readonly ok: boolean; readonly message: string;
  /** Bounce reporting is still not confirmed: the page keeps offering "Repair bounce reporting". */
  readonly bounceRepair?: boolean;
  /** An automatic check whose answer matched what was stored (nothing was written). */
  readonly unchanged?: boolean;
}

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
    // Postmark tested our endpoint during the create and a trigger failed: nothing was saved there; Continue tries again.
    if (error.errorCode === POSTMARK_CODES.webhookVerificationFailed) return new StepFailure('webhook_unreachable', EMAIL_CONNECTION_MESSAGES.webhookUnreachable);
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

  /**
   * The light read for the status card (home and follow-ups pages): the stored state only, one query. No name-server
   * look-up, no secrets check, no Postmark. null when the feature is off or the database lacks 0155.
   */
  async entryState(identity: PortalSessionIdentity): Promise<EmailConnectionState | null> {
    if (!this.enabled) return null;
    const business = this.business(identity);
    try { return await this.input.store.state(identity.sessionToken, business.workspaceId); }
    catch (error) { if (error instanceof EmailConnectionAbsentError) return null; throw error; }
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
      const existing = (await serverApi.listWebhooks(BROADCAST_STREAM)).filter(hook => sameWebhookAddress(hook.url, url));
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
      return { ok: true, message: domain.dkimVerified && domain.returnPathVerified ? EMAIL_CONNECTION_MESSAGES.startedFound : EMAIL_CONNECTION_MESSAGES.started };
    } catch (error) {
      if (error instanceof EmailConnectionError) throw error;
      if (error instanceof EmailConnectionForbiddenError) throw this.storeError(error);
      const failure = failureOf(error, state.domain);
      // Logged with the step and the Postmark status and code only; never a token, a secret or Postmark's text.
      this.log(JSON.stringify({ event: 'email.connections.step_failed', level: 'warn', step, outcome: failure.outcome,
        ...(error instanceof PostmarkAccountError ? { status: error.status, code: error.errorCode } : {}) }));
      if (failure.outcome === 'webhook_unreachable' && error instanceof PostmarkAccountError) {
        // Which of our triggers Postmark could not get a 200 from, and what it got (type names and numbers only).
        this.log(JSON.stringify({ event: 'email.connections.webhook_verification_failed', level: 'warn', workspace: ws.slice(0, 8), reason: 'verify_failed',
          failing: error.failingTriggers.map(item => ({ trigger: item.trigger, status: item.status })) }));
      }
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
  private async repair(identity: PortalSessionIdentity, business: EmailConnectBusiness, state: EmailConnectionState, lock: RunLock,
    why: 'secrets' | 'bounce_webhook' = 'secrets'): Promise<EmailConnectionResult> {
    const { store } = this.input, token = identity.sessionToken, ws = business.workspaceId;
    this.repairAllowed(state);
    // repairAllowed() refuses a missing domain or sender; this narrows the types for begin().
    if (!state.domain || !state.fromName || !state.fromAddress) throw new EmailConnectionError(409, EMAIL_CONNECTION_MESSAGES.nothingToContinue, 'no_details');
    this.log(JSON.stringify({ event: 'email.connections.repair', level: 'warn', workspace: ws.slice(0, 8), why,
      message: why === 'secrets' ? 'Saved email connection secrets could not be opened with EMAIL_CONNECTION_KEY; the webhook secret and webhook are being remade.'
        : 'The owner pressed Repair bounce reporting and the saved bounce webhook is not listed; the webhook secret and webhook are being remade.' }));
    try {
      await store.disconnect(token, ws);
      const begun = await store.begin(token, ws, { domain: state.domain, fromName: state.fromName, fromAddress: state.fromAddress, replyTo: state.replyTo }, EMAIL_TERMS_VERSION);
      if (begun !== 'started') throw new EmailConnectionError(409, EMAIL_CONNECTION_MESSAGES.unfinished, 'repair');
    } catch (error) { throw this.storeError(error); }
    // The stale webhook (secret we can no longer read) is found at our address and replaced by run().
    await this.run(identity, business, false, lock);
    return { ok: true, message: EMAIL_CONNECTION_MESSAGES.repaired };
  }

  /**
   * "Repair bounce reporting" (offered after Go live could not confirm the bounce webhook). Under the run lock:
   *   - secrets that no longer open: the existing repair (above);
   *   - the saved webhook listed on our stream at our address: verified at Postmark if it is not shown as verified
   *     (nothing is created, edited or deleted);
   *   - otherwise (no saved id, not listed, or listed at another address): the existing repair, which keeps the server,
   *     stream and domain, deletes only our own stale webhook at our address and creates one (secret saved and in force
   *     first), so there is never a second webhook at our address. 0155 saves a webhook id only while setting up, so the
   *     connection then waits for Check (and a fresh test) again.
   * The repair's own checks (the current email rules, the saved details) run BEFORE anything at Postmark is touched.
   * One 'email.connections.bounce_repair' line is written after the work, with what really happened.
   */
  async repairBounceReporting(identity: PortalSessionIdentity): Promise<EmailConnectionResult> {
    return this.locked(identity, async (business, lock) => {
      const config = this.input.config;
      if (!config.enabled) throw new EmailConnectionError(404, EMAIL_CONNECTION_MESSAGES.off, 'off');
      const state = await this.read(identity, business), ws = business.workspaceId;
      if (state.status !== 'verified' && state.status !== 'dns_pending') return { ok: false, message: EMAIL_CONNECTION_MESSAGES.nothingToCheck };
      const line = (fields: Record<string, unknown>) => this.log(JSON.stringify({ event: 'email.connections.bounce_repair', level: 'warn', workspace: ws.slice(0, 8), ...fields }));
      const failure = (error: unknown) => error instanceof PostmarkAccountError ? { category: error.category, httpStatus: error.status }
        : error instanceof EmailConnectionError ? { code: error.code } : { category: 'unexpected' };
      // An approved business that was live goes on by itself once a fresh test arrives: no Go live button is shown then.
      const remadeMessage = state.mode === 'live' && state.goLiveApprovedAt ? EMAIL_CONNECTION_MESSAGES.bounceRemadeLive : EMAIL_CONNECTION_MESSAGES.bounceRemade;
      const remake = async (reason: string, first?: { webhookId: number; serverToken: string }): Promise<EmailConnectionResult> => {
        // The repair's own refusals come first, so a refusal changes nothing at Postmark.
        try { this.repairAllowed(state); }
        catch (error) { line({ outcome: 'not_repaired', reason, failure: 'refused', ...failure(error) }); throw error; }
        if (first) {
          // Our own saved webhook, but pointing at another address: removed, so only the new one at our address remains.
          try { await this.serverApi(first.serverToken).deleteWebhook(first.webhookId).catch(error => { if (!missing(error)) throw error; }); }
          catch (error) {
            line({ outcome: 'not_repaired', reason, failure: 'delete_failed', ...failure(error) });
            throw new EmailConnectionError(503, EMAIL_CONNECTION_MESSAGES.busy, 'busy');
          }
        }
        try { await this.repair(identity, business, state, lock, reason === 'secrets_unreadable' ? 'secrets' : 'bounce_webhook'); }
        catch (error) { line({ outcome: 'not_repaired', reason, failure: 'remake_failed', ...failure(error) }); throw error; }
        // "remade" only when the run finished (Postmark answered the create with the new webhook, after testing it) AND our
        // row now holds a webhook id other than the one we started from.
        const after = await this.read(identity, business).catch(() => null);
        if (!after?.webhookId || (first && after.webhookId === first.webhookId)) {
          line({ outcome: 'not_repaired', reason, failure: 'not_saved' });
          return { ok: false, message: EMAIL_CONNECTION_MESSAGES.bounceNotSaved, bounceRepair: true };
        }
        line({ outcome: 'remade', reason });
        return { ok: true, message: remadeMessage };
      };
      if (await this.repairNeeded(identity, business, state)) return remake('secrets_unreadable');
      const sealed = await this.input.store.sealed(identity.sessionToken, ws);
      const serverToken = config.vault.open(ws, 'server_token', sealed.serverToken!);
      const url = connectionWebhookUrl(config.webhookOrigin, business), stream = state.stream ?? BROADCAST_STREAM;
      let listed;
      try { listed = state.webhookId ? (await this.serverApi(serverToken).listWebhooks(stream)).find(hook => hook.id === state.webhookId) ?? null : null; }
      catch (error) {
        line({ outcome: 'not_repaired', reason: 'list_failed', ...failure(error) });
        throw new EmailConnectionError(503, EMAIL_CONNECTION_MESSAGES.busy, 'busy');
      }
      if (listed && sameWebhookAddress(listed.url, url)) {
        const check = await confirmBounceWebhook({ webhookId: state.webhookId, stream, expectedUrl: url, token: async () => serverToken, api: this.serverApi });
        this.log(webhookCheckLine('email.connections.bounce_repair', ws, check));
        // Each message names a button the page shows in that state: Go live once connected, Check while waiting for it.
        if (check.confirmed) return { ok: true, message: state.status === 'dns_pending' ? EMAIL_CONNECTION_MESSAGES.bounceWorkingCheck
          : check.reason === 'listed_verified' ? EMAIL_CONNECTION_MESSAGES.bounceWorking : EMAIL_CONNECTION_MESSAGES.bounceRepaired };
        if (check.reason === 'verify_failed') return { ok: false, message: EMAIL_CONNECTION_MESSAGES.bounceStillFailing, bounceRepair: true };
        if (check.reason === 'verify_unrecognised') return { ok: false, message: EMAIL_CONNECTION_MESSAGES.bounceUnclear, bounceRepair: true };
        throw new EmailConnectionError(503, EMAIL_CONNECTION_MESSAGES.busy, 'busy');
      }
      return remake(!state.webhookId ? 'no_webhook_id' : listed ? 'other_address' : 'not_listed', listed ? { webhookId: listed.id, serverToken } : undefined);
    });
  }

  /** The checks repair() makes before it changes anything (the current email rules, and the saved details). */
  private repairAllowed(state: EmailConnectionState): void {
    if (state.terms?.version !== EMAIL_TERMS_VERSION) throw new EmailConnectionError(409, EMAIL_CONNECTION_MESSAGES.termsFirst, 'terms');
    if (!state.domain || !state.fromName || !state.fromAddress) throw new EmailConnectionError(409, EMAIL_CONNECTION_MESSAGES.nothingToContinue, 'no_details');
  }

  /** "Check": Postmark verifies both records; its answer is stored; our look-ups only choose the message. */
  /**
   * options.repair false (the page's own once-a-minute check): secrets that no longer open are reported, never repaired,
   * so an automatic check never creates a webhook.
   */
  async check(identity: PortalSessionIdentity, options: { readonly repair?: boolean } = {}): Promise<EmailConnectionResult> {
    return this.locked(identity, async (business, lock) => {
      const account = this.account!;
      const state = await this.read(identity, business);
      if ((state.status !== 'dns_pending' && state.status !== 'verified') || !state.domainId || !state.domain) return { ok: false, message: EMAIL_CONNECTION_MESSAGES.nothingToCheck };
      if (state.terms?.version !== EMAIL_TERMS_VERSION) throw new EmailConnectionError(409, EMAIL_CONNECTION_MESSAGES.termsFirst, 'terms');
      // Secrets that no longer open (the key changed): the webhook is remade first, so the check answers truly.
      if (await this.repairNeeded(identity, business, state)) {
        if (options.repair === false) return { ok: false, message: EMAIL_CONNECTION_MESSAGES.autoCheckNeedsRepair };
        await this.repair(identity, business, state, lock);
      }
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
      // The page's own once-a-minute check writes only a real change: the same answer as stored adds no event and no
      // row version (so an open tab never makes the founder's buttons stale, nor fills the events table).
      const same = (a: { host: string; value: string; verified: boolean } | undefined, b: { host: string; value: string; verified: boolean }) =>
        Boolean(a) && a!.host === b.host && a!.value === b.value && a!.verified === b.verified;
      const unchanged = same(state.dns?.dkim, dns.dkim) && same(state.dns?.returnPath, dns.returnPath) && (state.status === 'verified') === (dkimOk && returnPathOk);
      if (!(options.repair === false && unchanged)) {
        try { await this.input.store.checked(identity.sessionToken, business.workspaceId, dns, dkimOk, returnPathOk); }
        catch (error) { throw this.storeError(error); }
      }
      const quiet = options.repair === false && unchanged ? { unchanged: true } : {};
      if (dkimOk && returnPathOk) return { ok: true, message: EMAIL_CONNECTION_MESSAGES.checkBoth, ...quiet };
      // Our own look-ups, only for the wording: is the missing record absent, or there with another value?
      const seen: { txt: DnsSeen | null; cname: DnsSeen | null } = {
        txt: dkimOk ? null : await lookUpTxt(this.resolver, dns.dkim.host, dns.dkim.value),
        cname: returnPathOk ? null : await lookUpCname(this.resolver, dns.returnPath.host, dns.returnPath.value),
      };
      if (seen.txt === 'different') return { ok: false, message: EMAIL_CONNECTION_MESSAGES.checkMismatch('TXT') };
      if (seen.cname === 'different') return { ok: false, message: EMAIL_CONNECTION_MESSAGES.checkMismatch('CNAME') };
      if (dkimOk || returnPathOk) return { ok: false, message: EMAIL_CONNECTION_MESSAGES.checkOne(dkimOk ? 'CNAME' : 'TXT'), ...quiet };
      return { ok: false, message: EMAIL_CONNECTION_MESSAGES.checkNone, ...quiet };
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
