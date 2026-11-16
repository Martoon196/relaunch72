/**
 * The owner's sending controls on /portal/email (release 2): the footer details and test list, "Send a test to me",
 * "Go live" (the first time: every condition, then the founder's approval), back to testing, the owner's own pause,
 * the banner, and "This address works now" for a hard-bounced address. And the founder's small page.
 *
 * The database checks the owner (and the founder) on every call; the founder is also checked here the way release 1
 * checks it for a domain take-over. While the database ends at 0155 none of this is offered and sending is unchanged.
 */
import { randomUUID } from 'node:crypto';
import type { PortalSessionIdentity } from '../portal/auth-service.js';
import type { EmailConnectionStore, EmailConnectionState } from '../email-connections/store.js';
import type { EmailConnectionVault } from '../email-connections/vault.js';
import { createPostmarkServerApi, type PostmarkServerApi } from '../email-connections/postmark-account-api.js';
import { confirmBounceWebhook, webhookCheckLine, type WebhookCheck } from '../email-connections/webhook-check.js';
import { emailConnectBusiness } from '../email-connections/config.js';
import { connectionWebhookUrl } from '../email-connections/service.js';
import { EMAIL_TERMS_VERSION } from '../email-connections/terms.js';
import { normalizePpEmail } from '../pp-followup/config.js';
import { refusesReservedRecipient } from '../email-bounces/undeliverable.js';
import type { EmailBounceService } from '../email-bounces/service.js';
import { tripFromNumbers, type Trip } from './rules.js';
import { sendingDecision } from './sending.js';
import { ownerBanner, type Banner } from './messages.js';
import { EmailProtectionAbsentError, EmailProtectionForbiddenError, EmailProtectionInvalidError, type EmailProtectionStore, type FounderAction,
  type ProtectionStatus, type ReserveOutcome, type SendingConfig, type SendingState } from './store.js';
import { founderToday, type EmailProtectionService, type FounderToday } from './service.js';

export const SENDING_MESSAGES = Object.freeze({
  testSent: 'Sent. Check your inbox and spam folder.',
  testNoAddress: 'Add a test address first, or sign in with an email address we can send to.',
  testLimit: 'You have sent 20 test emails in the last hour. Please try again later.',
  testOff: 'Email sending is switched off for this business, so tests can\'t be sent.',
  testNotConnected: 'Connect your email first: both records need to be found.',
  testRefusedSender: 'The email service didn\'t accept the test from your address. Press Check again to confirm both records are still found, then try again.',
  testKeyUnreadable: 'We couldn\'t open your saved connection on our side. Press Repair (or Continue) on this page, then try again.',
  testReplayed: 'That test was already sent once. Check your inbox and spam folder.',
  testReplayedRefused: 'That test did not go the first time. Refresh this page and press Send a test to me again.',
  testRefusedRecipient: (address: string) => `The email service won't send to ${address}: it bounced or was reported as spam before. Use another test address.`,
  testReserved: (address: string) => `${address} can't receive email. Use a real test address.`,
  testUnknown: 'We couldn\'t tell whether the test was sent. Check your inbox in a few minutes before trying again.',
  detailsSaved: 'Saved.',
  needBusinessName: 'Enter your business\'s real name (2 to 120 characters, without < > " \\ or @).',
  needPostalAddress: 'Enter your business\'s postal address on one line (10 to 300 characters, without < > " \\ or @).',
  needTestList: 'Enter up to 10 test addresses, separated by commas.',
  requested: 'Waiting for approval. We will email you.',
  requestedNoEmail: 'Waiting for approval. Check this page for the answer.',
  live: 'You are live. Your marketing emails will now go out.',
  test: 'You are testing. Only your test addresses get emails.',
  unchanged: 'Nothing needed changing.',
  paused: 'Paused. No marketing emails will go until you press Resume.',
  resumed: 'Resumed. Your marketing emails can go again.',
  resumedStillHeld: (why: string) => `Resumed. ${why}`,
  switchedOff: 'Email sending is switched off for this business. Only we can switch it back on.',
  protectionPaused: 'Your marketing emails are paused by our protection. Only we can restart them.',
  needsWebhook: 'We couldn\'t confirm the email service will tell us about bounces. Press Repair bounce reporting below, then press Go live again.',
  needsTerms: 'Tick the latest email rules first.',
  needsFooter: 'Add your business\'s real name and postal address first. They go at the bottom of every marketing email.',
  needsTest: 'Send a test to yourself first. It must be accepted for sending since your email was last connected.',
  notFromHere: 'That isn\'t available from here. Refresh the page and try again.',
  notConnected: 'Connect your email first: both records need to be found.',
  busy: 'Something went wrong on our side. Nothing was changed. Please try again in a minute.',
  notAvailable: 'Sending isn\'t switched on here yet.',
  notFounder: 'Only the founder can do this.',
  founderDone: 'Done.',
  founderStale: 'This changed since the page was opened. Nothing was changed. Look again, then press once more.',
  founderNotNeeded: 'Nothing needed changing.',
});

export const LIFT_MESSAGES = Object.freeze({
  bothCleared: (address: string) => `We no longer block ${address}, and the email service will send to it again too.`,
  providerKept: (address: string) => `We no longer block ${address}, but the email service kept it on its own list, so it still won't send to it.`,
  providerUnreachable: (address: string) => `We no longer block ${address}, but the email service couldn't be reached to let it go too. Press the button again in a minute.`,
  noProvider: (address: string) => `We no longer block ${address}.`,
  providerNotBounced: (address: string) => `We no longer block ${address}. The email service didn't list it as bounced, so nothing needed changing there.`,
  spam: (address: string) => `${address} stays blocked: they marked one of your emails as spam. A spam report can't be undone, here or at the email service.`,
  notBlocked: (address: string) => `${address} has no bounce recorded in your records, so nothing changed here.`,
  unavailable: (_address: string) => 'Nothing changed: this list isn\'t kept in your records yet.',
});

export interface OwnerSendingView {
  readonly offered: boolean;
  readonly sending: SendingState | null;
  readonly banner: Banner | null;
  readonly testList: readonly string[];
  /** Hard bounces this business may say "works now" for (at most 50, newest first). */
  readonly bounced: readonly { readonly email: string; readonly since: string }[];
}

export type SendingResult = {
  readonly ok: boolean; readonly message: string;
  /** Go live was refused because the bounce webhook could not be confirmed: the page offers "Repair bounce reporting". */
  readonly bounceRepair?: boolean;
};

const TEST_SUBJECT = (from: string) => `Test email from ${from}`;

/** What the page knows about how the business is told: a working alert sender, and an owner address to send to. */
export interface BannerChannel { readonly mailer: boolean; readonly allowed?: boolean }

/** True while the business has never put its own connection in charge (then the environment sender runs and there is nothing to say). */
const neverInChargeOf = (mode: string, state: string, sending: Pick<SendingState, 'goLiveApprovedAt' | 'ownerPausedAt' | 'sampleState'>) =>
  mode === 'off' && state === 'ok' && !sending.goLiveApprovedAt && !sending.ownerPausedAt && sending.sampleState === 'none';

/** The banner a business sees, from its own state. */
export function bannerFor(connection: Pick<EmailConnectionState, 'mode' | 'protection' | 'status'>, sending: SendingState | null, channel: BannerChannel = { mailer: false }): Banner | null {
  if (!sending) return null;
  const step = sending.lastStep;
  const level: Trip['level'] = connection.protection.state === 'slowed' ? 'slowed' : 'paused';
  const trip = step && ['slowed', 'paused', 'switched_off'].includes(step.kind) ? tripFromNumbers(step, level) : null;
  const sampleTrip = step && step.kind === 'sample_held' ? tripFromNumbers(step, 'held') : null;
  const inCharge = !neverInChargeOf(connection.mode, connection.protection.state, sending);
  // "Reply to our email" only when an email about this really went, or is queued with a working sender and an address.
  const emailed = sending.lastOwnerAlert === 'sent' || (sending.lastOwnerAlert === 'pending' && channel.mailer && sending.ownerEmailCount > 0);
  return ownerBanner({ state: connection.protection.state, trip, reasonText: connection.protection.reason, dailyCap: connection.protection.dailyCap,
    sampleState: sending.sampleState, sampleTrip, ownerPaused: Boolean(sending.ownerPausedAt), accountHeld: sending.accountHeld, mode: connection.mode,
    waitingApproval: Boolean(sending.goLiveRequestedAt), notConnected: inCharge && connection.status !== 'verified',
    needsApproval: Boolean(sending.goLiveApprovedAt) && !sending.approvedCurrent && !sending.goLiveRequestedAt, needsTest: sending.approvedCurrent && !sending.testCurrent,
    switchedOffHere: inCharge && channel.allowed === false && connection.mode !== 'off', emailed, willEmail: channel.mailer && sending.ownerEmailCount > 0,
    secondPause: Boolean(step && step.kind === 'paused' && typeof step.previousPauseAt === 'string') });
}

/** The same banner from what the sender reads each sweep (for the follow-ups page, without a second read). */
export function bannerFromConfig(config: SendingConfig, channel: BannerChannel = { mailer: false }): Banner | null {
  return bannerFor({ mode: config.mode, status: config.status as EmailConnectionState['status'], protection: { state: config.protectionState, reason: config.protectionReason,
    since: null, dailyCap: config.dailyCap, hourlyCap: config.hourlyCap, warmupStartedAt: null } },
    { defaultTestEmail: null, ownerEmailCount: channel.mailer ? 1 : 0, testCurrent: config.testCurrent, approvedCurrent: config.approvedCurrent, lastOwnerAlert: channel.mailer ? 'pending' : null,
      businessName: config.businessName, postalAddress: config.postalAddress, testRecipients: config.testRecipients, testPassedAt: null,
      ownerPausedAt: config.ownerPaused ? 'paused' : null, goLiveRequestedAt: config.goLiveRequestedAt, goLiveApprovedAt: config.goLiveApprovedAt,
      sampleState: config.sampleState, warmupStep: 0, accountHeld: config.accountHeld, lastStep: config.lastStep, counts: null, days: [] }, channel);
}

/** What the follow-ups page says when sending could not be checked at all (the safe path: everyone waits). */
export const UNCHECKED_BANNER: Banner = Object.freeze({ tone: 'notice', title: 'We could not check email sending just now',
  text: 'We could not check email sending just now, so nothing is being sent. People you start wait and get their emails once we can check again. Refresh this page in a minute.' });

/**
 * The banner for a hold that the protection banner has no words for (a full cap, missing footer details, no test
 * address ...), so a held follow-ups page always says why. null only when nothing holds.
 */
export function holdBanner(reason: string, config: Pick<SendingConfig, 'dailyCap' | 'hourlyCap' | 'liveDay' | 'liveHour' | 'mode'> | null): Banner {
  if (reason === 'cap' && config) {
    return config.liveDay >= config.dailyCap
      ? { tone: 'notice', title: 'Today\'s limit is reached', text: `Today's limit of ${config.dailyCap.toLocaleString('en-GB')} emails has been reached. The rest go tomorrow.` }
      : { tone: 'notice', title: 'This hour\'s limit is reached', text: `This hour's limit of ${config.hourlyCap.toLocaleString('en-GB')} emails has been reached. The rest go next hour.` };
  }
  if (reason === 'needs_footer') return { tone: 'notice', title: 'Add your business details', text: 'Add your business name and postal address before marketing emails can go.' };
  if (reason === 'not_live' && config?.mode === 'test') return { tone: 'notice', title: 'Add a test address', text: 'Add a test address to send tests.' };
  if (reason === 'not_live') return { tone: 'notice', title: 'You are not live yet', text: 'You are not live yet, so no marketing emails go. Open your email page to start testing or go live.' };
  if (reason === 'unreadable') return { tone: 'alert', title: 'We could not open your connection', text: 'We could not open your saved connection on our side, so nothing is being sent. Open your email page and press Repair.' };
  if (reason === 'unavailable') return UNCHECKED_BANNER;
  return { tone: 'notice', title: 'Email sending is on hold', text: stillHeld(reason) };
}

/** In plain words, why marketing email is still not going (after the owner presses Resume), or null when nothing holds it. */
export function stillHeld(reason: string): string {
  const words: Record<string, string> = {
    paused: 'Your marketing emails are still paused by our protection; only we can restart them.',
    off: 'Email sending is still switched off for this business.',
    account_held: 'Marketing emails are still on hold for every business while we look into it.',
    sample_held: 'The rest of your list is still held until it is cleaned and we let it go.',
    sample_wait: 'Your first 50 emails went; the rest go once our 2-hour check is done.',
    not_approved: 'Your go-live still needs our approval.',
    needs_test: 'Send a test to yourself first; then your marketing emails go.',
    not_connected: 'Email is not connected right now, so nothing is being sent.',
    cap: 'You have reached today\'s limit; the rest go as the limit frees.',
    not_live: 'You are not live yet.',
    owner_paused: 'You have paused your marketing emails. Press Resume on your email page when you want them to go.',
    needs_footer: 'Add your business\'s real name and postal address first.',
    switched_off_here: 'Sending through your own connection is switched off on our side right now.',
  };
  return words[reason] ?? 'Something else is still holding your marketing emails; see the note at the top of this page.';
}

export class OwnerSendingService {
  private readonly fetcher: typeof fetch;
  constructor(private readonly input: { protection: EmailProtectionStore; connections: EmailConnectionStore; vault: EmailConnectionVault | null;
    evaluator?: Pick<EmailProtectionService, 'soon'>; bounces?: Pick<EmailBounceService, 'ownerLiftHardBounce' | 'refreshLedger' | 'reactivateAtProvider' | 'registry'>;
    founder?: (identity: PortalSessionIdentity) => Promise<boolean>; fetcher?: typeof fetch; serverApi?: (token: string) => PostmarkServerApi; log?: (line: string) => void;
    portalOrigin?: string | null;
    /** Whether alert emails can be sent (a platform sender is configured). */
    mailer?: () => boolean;
    /** Whether this deployment lets stored connections send (EMAIL_CONNECT enabled and bounce handling on). */
    allowed?: boolean }) {
    this.fetcher = input.fetcher ?? fetch;
  }
  private channel(): BannerChannel { return { mailer: this.input.mailer?.() === true, allowed: this.input.allowed !== false }; }

  /** The database has 0156. */
  async available(): Promise<boolean> { return this.input.protection.present(); }

  async view(identity: PortalSessionIdentity, connection: EmailConnectionState): Promise<OwnerSendingView> {
    let sending: SendingState | null = null;
    try { sending = await this.input.protection.state(identity.sessionToken, identity.workspaceId); }
    catch (error) { if (!(error instanceof EmailProtectionAbsentError)) throw error; return { offered: false, sending: null, banner: null, testList: [], bounced: [] }; }
    const testList = sending.testRecipients.length ? sending.testRecipients : sending.defaultTestEmail ? [sending.defaultTestEmail] : [];
    const bounced = this.input.bounces ? this.input.bounces.registry.snapshot(identity.workspaceId).blocked.filter(item => item.reason === 'hard_bounce')
      .slice(0, 50).map(item => ({ email: item.email, since: item.since })) : [];
    return { offered: true, sending, banner: bannerFor(connection, sending, this.channel()), testList, bounced };
  }

  async saveDetails(identity: PortalSessionIdentity, form: { businessName: string; postalAddress: string; testList: string }): Promise<SendingResult> {
    const name = form.businessName.trim(), address = form.postalAddress.trim().replace(/\s*[\r\n]+\s*/gu, ', ');
    if (name.length < 2 || name.length > 120 || /[\p{Cc}<>"\\@]/u.test(name)) return { ok: false, message: SENDING_MESSAGES.needBusinessName };
    if (address.length < 10 || address.length > 300 || /[\p{Cc}<>"\\@]/u.test(address)) return { ok: false, message: SENDING_MESSAGES.needPostalAddress };
    const raw = form.testList.split(/[,;\s]+/u).map(item => item.trim()).filter(Boolean);
    const list = raw.map(item => normalizePpEmail(item));
    if (list.length > 10 || list.some(item => !item || refusesReservedRecipient(this.fetcher, item))) return { ok: false, message: SENDING_MESSAGES.needTestList };
    try { await this.input.protection.details(identity.sessionToken, identity.workspaceId, { businessName: name, postalAddress: address, testRecipients: list as string[] }); }
    catch (error) { return this.refusal(error); }
    return { ok: true, message: SENDING_MESSAGES.detailsSaved };
  }

  private refusal(error: unknown): SendingResult {
    if (error instanceof EmailProtectionAbsentError) return { ok: false, message: SENDING_MESSAGES.notAvailable };
    if (error instanceof EmailProtectionForbiddenError) return { ok: false, message: 'Only an owner of this business can change its email.' };
    if (error instanceof EmailProtectionInvalidError) return { ok: false, message: SENDING_MESSAGES.needTestList };
    if ((error as { code?: unknown })?.code === '55000') return { ok: false, message: SENDING_MESSAGES.notConnected };
    this.input.log?.(JSON.stringify({ event: 'email.protection.owner_command_failed', level: 'warn' }));
    return { ok: false, message: SENDING_MESSAGES.busy };
  }

  /** The stored connection's own server token, from the owner's own session. */
  private async token(identity: PortalSessionIdentity): Promise<string | null> {
    if (!this.input.vault) return null;
    const sealed = await this.input.connections.sealed(identity.sessionToken, identity.workspaceId);
    if (!sealed.serverToken) return null;
    try { return this.input.vault.open(identity.workspaceId, 'server_token', sealed.serverToken); } catch { return null; }
  }

  /** "Send a test to me": one email to each test address (or the owner's own), through the business's own server and stream. */
  /** commandId (the page's own) makes a double submit send once: each recipient's test is keyed by it. */
  async sendTest(identity: PortalSessionIdentity, connection: EmailConnectionState, commandId: string = randomUUID()): Promise<SendingResult> {
    if (connection.status !== 'verified' || !connection.fromAddress || !connection.fromName) return { ok: false, message: SENDING_MESSAGES.testNotConnected };
    let sending: SendingState;
    try { sending = await this.input.protection.state(identity.sessionToken, identity.workspaceId); } catch (error) { return this.refusal(error); }
    const list = (sending.testRecipients.length ? sending.testRecipients : sending.defaultTestEmail ? [sending.defaultTestEmail] : []).map(item => normalizePpEmail(item)).filter((item): item is string => Boolean(item));
    if (!list.length) return { ok: false, message: SENDING_MESSAGES.testNoAddress };
    const token = await this.token(identity).catch(() => null);
    // Our own key could not open the saved token: that is ours to repair, never the email service's refusal.
    if (!token) return { ok: false, message: SENDING_MESSAGES.testKeyUnreadable };
    const footer = sending.businessName && sending.postalAddress ? `${sending.businessName} · ${sending.postalAddress}` : null;
    const text = `This is a test email from ${connection.fromName} <${connection.fromAddress}>.\n\nIf you can read this, your email is connected and ready.${footer ? `\n\n${footer}` : ''}`;
    let replayed = 0;
    for (const [index, to] of list.entries()) {
      if (refusesReservedRecipient(this.fetcher, to)) return { ok: false, message: SENDING_MESSAGES.testReserved(to) };
      const key = `test:${commandId}:${index}`;
      let reserved: ReserveOutcome;
      try { reserved = await this.input.protection.testReserve(identity.sessionToken, identity.workspaceId, key); } catch (error) { return this.refusal(error); }
      if (reserved === 'replayed') { replayed++; continue; }
      // A replay of an attempt that was refused, or never answered, is not "already sent".
      if (reserved === 'replayed_refused') return { ok: false, message: SENDING_MESSAGES.testReplayedRefused };
      if (reserved === 'replayed_unknown') return { ok: false, message: SENDING_MESSAGES.testUnknown };
      if (reserved !== 'ok') return { ok: false, message: reserved === 'test_limit' ? SENDING_MESSAGES.testLimit : reserved === 'off' ? SENDING_MESSAGES.testOff
        : SENDING_MESSAGES.testNotConnected };
      const outcome = await sendPostmarkTest({ fetcher: this.fetcher, token, stream: connection.stream ?? 'broadcast', fromName: connection.fromName, from: connection.fromAddress,
        replyTo: connection.replyTo ?? connection.fromAddress, to, subject: TEST_SUBJECT(connection.fromName), text });
      if (outcome !== 'unknown') await this.input.protection.testResult(identity.sessionToken, identity.workspaceId, key, outcome === 'accepted').catch(() => undefined);
      if (outcome === 'unknown') return { ok: false, message: SENDING_MESSAGES.testUnknown };
      if (outcome === 'recipient') return { ok: false, message: SENDING_MESSAGES.testRefusedRecipient(to) };
      if (outcome !== 'accepted') return { ok: false, message: SENDING_MESSAGES.testRefusedSender };
    }
    return { ok: true, message: replayed === list.length ? SENDING_MESSAGES.testReplayed : SENDING_MESSAGES.testSent };
  }

  /**
   * Whether Postmark has the bounce webhook saved for this business, verified, on its stream (asked now, with the server
   * token; see confirmBounceWebhook). Every outcome but "listed as verified" is logged as one
   * 'email.protection.go_live_webhook' line.
   */
  async webhookVerified(identity: PortalSessionIdentity, connection: EmailConnectionState): Promise<WebhookCheck> {
    // Our bounce address for this business: the same value Connect gave Postmark (portal origin + the business's source key).
    const business = emailConnectBusiness(identity.workspaceId);
    const expectedUrl = business && this.input.portalOrigin ? connectionWebhookUrl(this.input.portalOrigin, business) : null;
    const check = await confirmBounceWebhook({ webhookId: connection.webhookId, stream: connection.stream ?? 'broadcast', expectedUrl, token: () => this.token(identity),
      api: token => this.input.serverApi?.(token) ?? createPostmarkServerApi({ serverToken: token, fetch: this.fetcher }) });
    if (check.reason !== 'listed_verified') this.input.log?.(webhookCheckLine('email.protection.go_live_webhook', identity.workspaceId, check));
    return check;
  }

  /** test / live / pause / resume. */
  async command(identity: PortalSessionIdentity, connection: EmailConnectionState, action: 'test' | 'live' | 'pause' | 'resume'): Promise<SendingResult> {
    const webhookOk = action === 'live' ? (await this.webhookVerified(identity, connection)).confirmed : false;
    let outcome;
    try { outcome = await this.input.protection.command(identity.sessionToken, identity.workspaceId, action, EMAIL_TERMS_VERSION, webhookOk); }
    catch (error) { return this.refusal(error); }
    this.input.evaluator?.soon(identity.workspaceId);
    switch (outcome) {
      case 'live': return { ok: true, message: SENDING_MESSAGES.live };
      case 'test': return { ok: true, message: SENDING_MESSAGES.test };
      case 'requested': case 'already_requested': return { ok: true, message: await this.canEmailOwner(identity) ? SENDING_MESSAGES.requested : SENDING_MESSAGES.requestedNoEmail };
      case 'paused': return { ok: true, message: SENDING_MESSAGES.paused };
      case 'resumed': {
        // Only say they can go again when nothing else is holding them.
        const config = await this.input.protection.sendingConfig(identity.workspaceId).catch(() => null);
        const decision = sendingDecision(config, { allowed: this.input.allowed !== false });
        return { ok: true, message: decision.kind === 'hold' ? SENDING_MESSAGES.resumedStillHeld(stillHeld(decision.reason)) : SENDING_MESSAGES.resumed };
      }
      case 'unchanged': return { ok: true, message: SENDING_MESSAGES.unchanged };
      case 'switched_off': return { ok: false, message: SENDING_MESSAGES.switchedOff };
      case 'needs_webhook': return { ok: false, message: SENDING_MESSAGES.needsWebhook, bounceRepair: true };
      case 'needs_terms': return { ok: false, message: SENDING_MESSAGES.needsTerms };
      case 'needs_footer': return { ok: false, message: SENDING_MESSAGES.needsFooter };
      case 'needs_test': return { ok: false, message: SENDING_MESSAGES.needsTest };
      default: return { ok: false, message: outcome === 'not_connected' ? SENDING_MESSAGES.notConnected : SENDING_MESSAGES.protectionPaused };
    }
  }

  private async canEmailOwner(identity: PortalSessionIdentity): Promise<boolean> {
    if (this.input.mailer?.() !== true) return false;
    try { return (await this.input.protection.state(identity.sessionToken, identity.workspaceId)).ownerEmailCount > 0; } catch { return false; }
  }

  /** "This address works now": our hard-bounce block is lifted (0153), then Postmark's own suppression is deleted too. */
  async liftAddress(identity: PortalSessionIdentity, email: string): Promise<SendingResult> {
    const address = normalizePpEmail(email) ?? String(email).slice(0, 254);
    const bounces = this.input.bounces;
    if (!bounces) return { ok: false, message: LIFT_MESSAGES.unavailable(address) };
    let result;
    try { result = await bounces.ownerLiftHardBounce({ sessionToken: identity.sessionToken, workspaceId: identity.workspaceId, email: address,
      note: 'Owner confirmed on the email page that this address works now' }); }
    catch { return { ok: false, message: SENDING_MESSAGES.busy }; }
    if (!result) return { ok: false, message: LIFT_MESSAGES.unavailable(address) };
    await bounces.refreshLedger(identity.workspaceId);
    if (result.spamComplaint) return { ok: false, message: LIFT_MESSAGES.spam(address) };
    if (result.lifted === 0 && !result.alreadyLifted) return { ok: false, message: LIFT_MESSAGES.notBlocked(address) };
    return liftOutcome(address, await bounces.reactivateAtProvider(identity.workspaceId, address));
  }

  // ------------------------------------------------------------------ the founder

  private async isFounder(identity: PortalSessionIdentity): Promise<boolean> {
    try { return (await this.input.founder?.(identity)) === true; } catch { return false; }
  }

  async founderView(identity: PortalSessionIdentity): Promise<{ readonly status: ProtectionStatus; readonly today: FounderToday } | null> {
    if (!(await this.isFounder(identity))) return null;
    let status: ProtectionStatus;
    try { status = await this.input.protection.founderView(identity.sessionToken); }
    catch (error) { if (error instanceof EmailProtectionForbiddenError || error instanceof EmailProtectionAbsentError) return null; throw error; }
    return { status, today: founderToday(status, `${this.input.portalOrigin ?? ''}/portal/email/founder`) };
  }

  async founderAct(identity: PortalSessionIdentity, workspaceId: string | null, action: FounderAction, version: number): Promise<SendingResult> {
    if (!(await this.isFounder(identity))) return { ok: false, message: SENDING_MESSAGES.notFounder };
    let outcome;
    try { outcome = await this.input.protection.founderAct(identity.sessionToken, workspaceId, action, version); }
    catch (error) { if (error instanceof EmailProtectionForbiddenError) return { ok: false, message: SENDING_MESSAGES.notFounder }; return this.refusal(error); }
    if (outcome === 'done' && workspaceId) this.input.evaluator?.soon(workspaceId);
    return outcome === 'done' ? { ok: true, message: SENDING_MESSAGES.founderDone } : { ok: false, message: outcome === 'stale' ? SENDING_MESSAGES.founderStale : SENDING_MESSAGES.founderNotNeeded };
  }
}

export function liftOutcome(address: string, provider: 'deleted' | 'failed' | 'unavailable' | 'none' | 'not_bounced'): SendingResult {
  if (provider === 'deleted') return { ok: true, message: LIFT_MESSAGES.bothCleared(address) };
  if (provider === 'not_bounced') return { ok: true, message: LIFT_MESSAGES.providerNotBounced(address) };
  if (provider === 'failed') return { ok: true, message: LIFT_MESSAGES.providerKept(address) };
  if (provider === 'unavailable') return { ok: true, message: LIFT_MESSAGES.providerUnreachable(address) };
  return { ok: true, message: LIFT_MESSAGES.noProvider(address) };
}

/** One test email on the business's own Broadcast stream. 'accepted', 'sender' / 'recipient' / 'message' (definitely not sent), or 'unknown'. */
export async function sendPostmarkTest(input: { fetcher: typeof fetch; token: string; stream: string; fromName: string; from: string; replyTo: string; to: string;
  subject: string; text: string }): Promise<'accepted' | 'sender' | 'recipient' | 'message' | 'unknown'> {
  let response: Response;
  try {
    response = await input.fetcher('https://api.postmarkapp.com/email', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/json', accept: 'application/json', 'X-Postmark-Server-Token': input.token },
      body: JSON.stringify({ From: `"${input.fromName}" <${input.from}>`, To: input.to, ReplyTo: input.replyTo, Subject: input.subject, TextBody: input.text,
        MessageStream: input.stream, Tag: 'connection_test', TrackOpens: false, TrackLinks: 'None' }) });
  } catch { return 'unknown'; }
  let code: unknown = undefined, id: unknown = undefined;
  try { const body = await response.json() as { ErrorCode?: unknown; MessageID?: unknown }; code = body?.ErrorCode; id = body?.MessageID; } catch { /* unreadable */ }
  if (response.ok && code === 0 && typeof id === 'string' && id) return 'accepted';
  if (response.ok && typeof code === 'number' && code !== 0) return [10, 400, 401, 405, 412, 413].includes(code) ? 'sender' : code === 406 ? 'recipient' : 'message';
  if (response.status >= 400 && response.status < 500 && response.status !== 408) {
    if ([401, 403, 429].includes(response.status) || [10, 400, 401, 405, 412, 413].includes(Number(code))) return 'sender';
    return Number(code) === 406 ? 'recipient' : 'message';
  }
  return 'unknown';
}

