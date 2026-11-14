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
import { EMAIL_TERMS_VERSION } from '../email-connections/terms.js';
import { normalizePpEmail } from '../pp-followup/config.js';
import { refusesReservedRecipient } from '../email-bounces/undeliverable.js';
import type { EmailBounceService } from '../email-bounces/service.js';
import { tripFromNumbers, type Trip } from './rules.js';
import { ownerBanner, type Banner } from './messages.js';
import { EmailProtectionAbsentError, EmailProtectionForbiddenError, EmailProtectionInvalidError, type EmailProtectionStore, type FounderAction,
  type ProtectionStatus, type ReserveOutcome, type SendingConfig, type SendingState } from './store.js';
import { founderToday, type EmailProtectionService, type FounderToday } from './service.js';

export const SENDING_MESSAGES = Object.freeze({
  testSent: 'Sent. Check your inbox and spam folder.',
  testNoAddress: 'Add a test address first, or sign in with an email address we can send to.',
  testLimit: 'You have sent 20 test emails in the last hour. Please try again later.',
  testOff: 'Email sending is switched off for this business, so tests can\'t be sent.',
  testOwnerPaused: 'You have paused your emails. Press Resume first, then send a test.',
  testNotConnected: 'Connect your email first: both records need to be found.',
  testRefusedSender: 'The email service didn\'t accept the test from your address. Press Check again to confirm both records are still found, then try again.',
  testRefusedRecipient: (address: string) => `The email service won't send to ${address}: it bounced or was reported as spam before. Use another test address.`,
  testReserved: (address: string) => `${address} can't receive email. Use a real test address.`,
  testUnknown: 'We couldn\'t tell whether the test was sent. Check your inbox in a few minutes before trying again.',
  detailsSaved: 'Saved.',
  needBusinessName: 'Enter your business\'s real name (2 to 120 characters, without < > " \\ or @).',
  needPostalAddress: 'Enter your business\'s postal address on one line (10 to 300 characters, without < > " \\ or @).',
  needTestList: 'Enter up to 10 test addresses, separated by commas.',
  requested: 'Waiting for approval. We will email you.',
  alreadyRequested: 'Waiting for approval. We will email you.',
  live: 'You are live. Your marketing emails will now go out.',
  test: 'You are testing. Only your test addresses get emails.',
  unchanged: 'Nothing needed changing.',
  paused: 'Paused. No marketing emails will go until you press Resume.',
  resumed: 'Resumed. Your marketing emails can go again.',
  switchedOff: 'Email sending is switched off for this business. Only we can switch it back on: reply to our email to ask for a review.',
  protectionPaused: 'Your marketing emails are paused by our protection. Only we can restart them: reply to our email.',
  needsWebhook: 'We couldn\'t confirm the email service will tell us about bounces. Press Repair or Check again, then try once more.',
  needsTerms: 'Tick the latest email rules first.',
  needsFooter: 'Add your business\'s real name and postal address first. They go at the bottom of every marketing email.',
  needsTest: 'Send a test to yourself first, and check it arrived.',
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

export type SendingResult = { readonly ok: boolean; readonly message: string };

const TEST_SUBJECT = (from: string) => `Test email from ${from}`;

/** The banner a business sees, from its own state. */
export function bannerFor(connection: Pick<EmailConnectionState, 'mode' | 'protection'>, sending: SendingState | null): Banner | null {
  if (!sending) return null;
  const step = sending.lastStep;
  const level: Trip['level'] = connection.protection.state === 'slowed' ? 'slowed' : 'paused';
  const trip = step && ['slowed', 'paused', 'switched_off'].includes(step.kind) ? tripFromNumbers(step, level) : null;
  const sampleTrip = step && step.kind === 'sample_held' ? tripFromNumbers(step, 'held') : null;
  return ownerBanner({ state: connection.protection.state, trip, dailyCap: connection.protection.dailyCap, sampleState: sending.sampleState, sampleTrip,
    ownerPaused: Boolean(sending.ownerPausedAt), accountHeld: sending.accountHeld, mode: connection.mode,
    waitingApproval: Boolean(sending.goLiveRequestedAt && !sending.goLiveApprovedAt) });
}

/** The same banner from what the sender reads each sweep (for the follow-ups page, without a second read). */
export function bannerFromConfig(config: SendingConfig): Banner | null {
  return bannerFor({ mode: config.mode, protection: { state: config.protectionState, reason: null, since: null, dailyCap: config.dailyCap, hourlyCap: config.hourlyCap, warmupStartedAt: null } },
    { ownEmail: null, businessName: config.businessName, postalAddress: config.postalAddress, testRecipients: config.testRecipients, testPassedAt: null,
      ownerPausedAt: config.ownerPaused ? 'paused' : null, goLiveRequestedAt: config.goLiveRequestedAt, goLiveApprovedAt: config.goLiveApprovedAt,
      sampleState: config.sampleState, warmupStep: 0, accountHeld: config.accountHeld, lastStep: config.lastStep, counts: null, days: [] });
}

export class OwnerSendingService {
  private readonly fetcher: typeof fetch;
  constructor(private readonly input: { protection: EmailProtectionStore; connections: EmailConnectionStore; vault: EmailConnectionVault | null;
    evaluator?: Pick<EmailProtectionService, 'soon'>; bounces?: Pick<EmailBounceService, 'ownerLiftHardBounce' | 'refreshLedger' | 'reactivateAtProvider' | 'registry'>;
    founder?: (identity: PortalSessionIdentity) => Promise<boolean>; fetcher?: typeof fetch; serverApi?: (token: string) => PostmarkServerApi; log?: (line: string) => void;
    portalOrigin?: string | null }) {
    this.fetcher = input.fetcher ?? fetch;
  }

  /** The database has 0156. */
  async available(): Promise<boolean> { return this.input.protection.present(); }

  async view(identity: PortalSessionIdentity, connection: EmailConnectionState): Promise<OwnerSendingView> {
    let sending: SendingState | null = null;
    try { sending = await this.input.protection.state(identity.sessionToken, identity.workspaceId); }
    catch (error) { if (!(error instanceof EmailProtectionAbsentError)) throw error; return { offered: false, sending: null, banner: null, testList: [], bounced: [] }; }
    const testList = sending.testRecipients.length ? sending.testRecipients : sending.ownEmail ? [sending.ownEmail] : [];
    const bounced = this.input.bounces ? this.input.bounces.registry.snapshot(identity.workspaceId).blocked.filter(item => item.reason === 'hard_bounce')
      .slice(0, 50).map(item => ({ email: item.email, since: item.since })) : [];
    return { offered: true, sending, banner: bannerFor(connection, sending), testList, bounced };
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
  async sendTest(identity: PortalSessionIdentity, connection: EmailConnectionState): Promise<SendingResult> {
    if (connection.status !== 'verified' || !connection.fromAddress || !connection.fromName) return { ok: false, message: SENDING_MESSAGES.testNotConnected };
    let sending: SendingState;
    try { sending = await this.input.protection.state(identity.sessionToken, identity.workspaceId); } catch (error) { return this.refusal(error); }
    const list = (sending.testRecipients.length ? sending.testRecipients : sending.ownEmail ? [sending.ownEmail] : []).map(item => normalizePpEmail(item)).filter((item): item is string => Boolean(item));
    if (!list.length) return { ok: false, message: SENDING_MESSAGES.testNoAddress };
    const token = await this.token(identity).catch(() => null);
    if (!token) return { ok: false, message: SENDING_MESSAGES.testRefusedSender };
    const footer = sending.businessName && sending.postalAddress ? `${sending.businessName} · ${sending.postalAddress}` : null;
    const text = `This is a test email from ${connection.fromName} <${connection.fromAddress}>.\n\nIf you can read this, your email is connected and ready.${footer ? `\n\n${footer}` : ''}`;
    for (const to of list) {
      if (refusesReservedRecipient(this.fetcher, to)) return { ok: false, message: SENDING_MESSAGES.testReserved(to) };
      const key = `test:${randomUUID()}`;
      let reserved: ReserveOutcome;
      try { reserved = await this.input.protection.testReserve(identity.sessionToken, identity.workspaceId, key); } catch (error) { return this.refusal(error); }
      if (reserved !== 'ok') return { ok: false, message: reserved === 'test_limit' ? SENDING_MESSAGES.testLimit : reserved === 'off' ? SENDING_MESSAGES.testOff
        : reserved === 'owner_paused' ? SENDING_MESSAGES.testOwnerPaused : SENDING_MESSAGES.testNotConnected };
      const outcome = await sendPostmarkTest({ fetcher: this.fetcher, token, stream: connection.stream ?? 'broadcast', fromName: connection.fromName, from: connection.fromAddress,
        replyTo: connection.replyTo ?? connection.fromAddress, to, subject: TEST_SUBJECT(connection.fromName), text });
      if (outcome !== 'unknown') await this.input.protection.testResult(identity.sessionToken, identity.workspaceId, key, outcome === 'accepted').catch(() => undefined);
      if (outcome === 'unknown') return { ok: false, message: SENDING_MESSAGES.testUnknown };
      if (outcome === 'recipient') return { ok: false, message: SENDING_MESSAGES.testRefusedRecipient(to) };
      if (outcome !== 'accepted') return { ok: false, message: SENDING_MESSAGES.testRefusedSender };
    }
    return { ok: true, message: SENDING_MESSAGES.testSent };
  }

  /** Whether Postmark has the bounce webhook saved for this business, verified, on its stream (asked now, with the server token). */
  private async webhookVerified(identity: PortalSessionIdentity, connection: EmailConnectionState): Promise<boolean> {
    if (!connection.webhookId) return false;
    try {
      const token = await this.token(identity);
      if (!token) return false;
      const api = this.input.serverApi?.(token) ?? createPostmarkServerApi({ serverToken: token, fetch: this.fetcher });
      return (await api.listWebhooks(connection.stream ?? 'broadcast')).some(hook => hook.id === connection.webhookId && hook.status === 'verified');
    } catch { return false; }
  }

  /** test / live / pause / resume. */
  async command(identity: PortalSessionIdentity, connection: EmailConnectionState, action: 'test' | 'live' | 'pause' | 'resume'): Promise<SendingResult> {
    const webhookOk = action === 'live' ? await this.webhookVerified(identity, connection) : false;
    let outcome;
    try { outcome = await this.input.protection.command(identity.sessionToken, identity.workspaceId, action, EMAIL_TERMS_VERSION, webhookOk); }
    catch (error) { return this.refusal(error); }
    this.input.evaluator?.soon(identity.workspaceId);
    switch (outcome) {
      case 'live': return { ok: true, message: SENDING_MESSAGES.live };
      case 'test': return { ok: true, message: SENDING_MESSAGES.test };
      case 'requested': return { ok: true, message: SENDING_MESSAGES.requested };
      case 'already_requested': return { ok: true, message: SENDING_MESSAGES.alreadyRequested };
      case 'paused': return { ok: true, message: SENDING_MESSAGES.paused };
      case 'resumed': return { ok: true, message: SENDING_MESSAGES.resumed };
      case 'unchanged': return { ok: true, message: SENDING_MESSAGES.unchanged };
      case 'switched_off': return { ok: false, message: SENDING_MESSAGES.switchedOff };
      case 'needs_webhook': return { ok: false, message: SENDING_MESSAGES.needsWebhook };
      case 'needs_terms': return { ok: false, message: SENDING_MESSAGES.needsTerms };
      case 'needs_footer': return { ok: false, message: SENDING_MESSAGES.needsFooter };
      case 'needs_test': return { ok: false, message: SENDING_MESSAGES.needsTest };
      default: return { ok: false, message: outcome === 'not_connected' ? SENDING_MESSAGES.notConnected : SENDING_MESSAGES.protectionPaused };
    }
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

export function liftOutcome(address: string, provider: 'deleted' | 'failed' | 'unavailable' | 'none'): SendingResult {
  if (provider === 'deleted') return { ok: true, message: LIFT_MESSAGES.bothCleared(address) };
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

