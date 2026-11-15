/**
 * Every sentence a business owner or the founder reads about sender protection. Plain English, and true: each figure
 * comes from the durable counters at that moment, percentages are rounded down, and nothing claims more than the
 * system does. No setting names, no provider text, no addresses.
 */
import { ACCOUNT, LADDER, POSTMARK_LINES, RESTART_MIN_SENDS_FOR_OFF, SAMPLE, percent, type ProtectionState, type SampleState, type Trip } from './rules.js';

const plural = (n: number, one: string, many: string): string => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;
const num = (n: number): string => n.toLocaleString('en-GB');
/** "your last email was" / "your last 12 were": true for any number, 1 included. */
const lastOnes = (who: 'your' | 'their', n: number): string => n === 1 ? `${who} last email was` : `${who} last ${num(n)} were`;
/** The account lines, about the whole shared account (true whether one business sends through it or many). */
function accountWide(trip: Trip): string {
  return trip.line === 'account_bounce'
    ? `Across our shared email account (every business that sends through it), ${num(trip.count)} of ${num(trip.total)} emails bounced in the last ${trip.days ?? 7} days (${percent(trip.count, trip.total)}). Our limit is ${trip.limit}%.`
    : `Across our shared email account (every business that sends through it), ${plural(trip.count, 'person', 'people')} marked emails as spam in the last ${trip.days ?? 30} days, out of ${num(trip.total)} emails. Our limit is 1 in ${num(10_000 / trip.limit)}.`;
}
/** Why the account trip-wire picked this business: the highest rate, or the next one in the same pass. */
const pickedBecause = (trip: Trip): string => (trip.rank ?? 1) <= 1
  ? 'and your rate was the highest, so we paused yours first.'
  : 'and after we paused the business with the highest rate it was still over, so we paused yours, the next highest, too.';
/** Whether a logged trip came from the account trip-wire (it never counts toward switching email off). */
export const accountCaused = (trip: Trip | null): boolean => trip?.line === 'account_bounce' || trip?.line === 'account_complaint';

/** What still works whatever happens to a business's marketing email. True: protection only holds the marketing sender. */
export const STILL_GOES = 'Sign-in links, receipts and booking and webinar confirmations still go.';

/** "What tripped", to the business, in the second person. */
export function ownerTripped(trip: Trip | null): string {
  if (!trip) return '';
  switch (trip.line) {
    case 'bounce_rate':
      return trip.blocked
        ? `In the last ${trip.days ?? LADDER.bounceWindowDays} days, ${num(trip.count)} of your ${num(trip.total)} emails bounced or were blocked as spam by the receiving email service (${percent(trip.count, trip.total)}). Our limit is ${trip.limit}%.`
        : `In the last ${trip.days ?? LADDER.bounceWindowDays} days, ${num(trip.count)} of your ${num(trip.total)} emails bounced (${percent(trip.count, trip.total)}). Our limit is ${trip.limit}%.`;
    case 'hard_last50':
      return `${plural(trip.count, 'email', 'emails')} came straight back as undeliverable while ${lastOnes('your', trip.total)} going out. Our limit is ${trip.limit}.`;
    case 'complaints':
      return `${plural(trip.count, 'person', 'people')} marked your emails as spam in the last ${trip.days ?? LADDER.complaintWindowDays} days. Our limit is ${trip.limit}.`;
    case 'sample':
      return `We sent the first ${num(trip.total)} emails and checked them: ${num(trip.count)} bounced and ${plural(trip.own?.count ?? 0, 'person', 'people')} marked one as spam. Our limit is 1 bounce and no spam reports.`;
    // Only the business's own numbers: never another business's.
    // A hold of the whole account has no share of its own: the account's figures only.
    case 'account_bounce':
      if (!trip.own) return accountWide(trip);
      return `In the last 7 days, ${num(trip.own.count)} of your ${num(trip.own.total)} emails bounced (${percent(trip.own.count, trip.own.total)}). Together with other businesses this took our shared email account over its ${trip.limit}% limit, ${pickedBecause(trip)}`;
    case 'account_complaint':
      if (!trip.own) return accountWide(trip);
      return `${plural(trip.own.count, 'person', 'people')} marked your emails as spam in the last 30 days (out of ${num(trip.own.total)} emails). Together with other businesses this took our shared email account over its limit of 1 in ${num(10_000 / trip.limit)} emails, ${pickedBecause(trip)}`;
    case 'restarted':
      return '';
  }
}

/** The same, about a business, for the founder. */
export function founderTripped(trip: Trip | null): string {
  if (!trip) return '';
  switch (trip.line) {
    case 'bounce_rate':
      return `${num(trip.count)} of their last ${num(trip.total)} emails bounced${trip.blocked ? ` or were blocked (${num(trip.blocked)} blocked)` : ''} (${percent(trip.count, trip.total)}, last ${trip.days ?? 7} days). Our line is ${trip.limit}%, Postmark's is ${POSTMARK_LINES.bouncePercent}%.`;
    case 'hard_last50':
      return `${plural(trip.count, 'email', 'emails')} came straight back while ${lastOnes('their', trip.total)} going out. Our line is ${trip.limit}.`;
    case 'complaints':
      return `${plural(trip.count, 'person', 'people')} marked their emails as spam in the last ${trip.days ?? 30} days. Our line is ${trip.limit}, Postmark's is 1 in 1,000 emails.`;
    case 'sample':
      return `Their first ${num(trip.total)} emails: ${num(trip.count)} bounced, ${plural(trip.own?.count ?? 0, 'spam report', 'spam reports')}.`;
    case 'account_bounce':
      return `The whole account: ${num(trip.count)} of ${num(trip.total)} emails bounced in the last 7 days (${percent(trip.count, trip.total)})${trip.own ? `; theirs: ${num(trip.own.count)} of ${num(trip.own.total)}${(trip.rank ?? 1) > 1 ? ' (the next highest after the business paused before it)' : ''}` : ''}. Our account line is ${trip.limit}%.`;
    case 'account_complaint':
      return `The whole account: ${plural(trip.count, 'spam report', 'spam reports')} in ${num(trip.total)} emails over 30 days${trip.own ? `; theirs: ${num(trip.own.count)} in ${num(trip.own.total)}${(trip.rank ?? 1) > 1 ? ' (the next highest after the business paused before it)' : ''}` : ''}. Our account line is 1 in ${num(10_000 / trip.limit)}.`;
    case 'restarted':
      return '';
  }
}

export interface OwnerBannerInput {
  readonly state: ProtectionState;
  readonly trip: Trip | null;
  /** The stored reason, when the trip itself is not the latest logged step (e.g. slowed under a released sample). */
  readonly reasonText?: string | null;
  readonly dailyCap: number;
  readonly sampleState: SampleState;
  readonly sampleTrip: Trip | null;
  readonly ownerPaused: boolean;
  readonly accountHeld: boolean;
  readonly mode: 'off' | 'test' | 'live';
  readonly waitingApproval: boolean;
  /** The stored connection is in charge but not connected right now (nothing is sent). */
  readonly notConnected?: boolean;
  /** Live, but the founder's approval was for another domain (a new one needs approving again). */
  readonly needsApproval?: boolean;
  /** Live, but no test was accepted since the connection was verified again. */
  readonly needsTest?: boolean;
  /** Sending through stored connections is switched off on this deployment. */
  readonly switchedOffHere?: boolean;
  /** An alert email about this step really went (or is queued with a working sender) to an owner address: only then "reply to our email". */
  readonly emailed?: boolean;
  /** An approval email can reach the owner (a working sender and an owner address): only then "We will email you". */
  readonly willEmail?: boolean;
}

export interface Banner { readonly tone: 'alert' | 'notice' | 'ok'; readonly title: string; readonly text: string }

/** The business's banner, strongest first, or null when there is nothing to say. Shown on /portal/email and the follow-ups page. */
export function ownerBanner(input: OwnerBannerInput): Banner | null {
  const what = (trip: Trip | null, fallback: string | null = null) => { const t = ownerTripped(trip) || fallback || ''; return t ? `${t} ` : ''; };
  const tell = input.emailed ? 'reply to our email' : 'tell us (we can see this too)';
  if (input.state === 'off') return { tone: 'alert', title: 'Your email sending is switched off',
    text: `${what(input.trip)}It was paused twice within ${LADDER.secondPauseDays} days, so we switched it off to protect everyone who sends through our shared account. ${STILL_GOES} Your marketing emails are waiting and go only if we switch it back on: ${tell} to ask for a review.` };
  if (input.notConnected) return { tone: 'alert', title: 'Email is not connected right now',
    text: 'Email is not connected right now, so nothing is being sent. Reconnect it to carry on. People you have started are waiting and will go when it is connected again.' };
  if (input.switchedOffHere) return { tone: 'alert', title: 'Sending is switched off on our side',
    text: 'Sending through your own connection is switched off on our side right now, so nothing is being sent. Your marketing emails are waiting and will go when it is back.' };
  if (input.state === 'paused') return { tone: 'alert', title: 'Your marketing emails are paused',
    text: `${what(input.trip, input.reasonText ?? null)}${STILL_GOES} No other business is affected. Your marketing emails are waiting and will go when we restart them. To restart: remove the addresses that bounced or complained, check where your newest addresses came from, then ${tell}. ${accountCaused(input.trip)
      ? 'Only we can restart it. This pause came from our shared account\'s limit, so it does not count toward switching your email off.'
      : `Only we can restart it, and a second pause within ${LADDER.secondPauseDays} days switches your email off.`}` };
  if (input.accountHeld && input.mode === 'live') return { tone: 'alert', title: 'Marketing emails are on hold for everyone',
    text: `Marketing emails are on hold for every business that sends through our shared email account while we look into it. ${STILL_GOES} Yours are waiting and will go when the hold is lifted. You don't need to do anything.` };
  if (input.sampleState === 'held' && input.mode === 'live') return { tone: 'alert', title: 'We have held the rest of your list',
    text: `${what(input.sampleTrip)}The rest of this list is waiting and will go when it is cleaned and we let it go. Remove old, bought or guessed addresses, then ${tell}. ${STILL_GOES}` };
  if (input.ownerPaused) return { tone: 'notice', title: 'You have paused your marketing emails',
    text: 'Nothing marketing goes until you press Resume; everything is waiting. Send a test to me still works.' };
  if (input.waitingApproval) return { tone: 'notice', title: 'Waiting for approval',
    text: input.willEmail ? 'Waiting for approval. We will email you.' : 'Waiting for approval. Check this page for the answer.' };
  if (input.mode === 'live' && input.needsApproval) return { tone: 'notice', title: 'Your new sending address needs approval',
    text: 'Your sending address changed, so it needs our approval again. Press Go live to ask. Your marketing emails are waiting until then.' };
  if (input.mode === 'live' && input.needsTest) return { tone: 'notice', title: 'Send a test first',
    text: 'Your email was connected again, so send a test to yourself before your marketing emails go again. They are waiting until then.' };
  if (input.state === 'slowed') return { tone: 'notice', title: 'We have slowed your marketing emails',
    text: `${what(input.trip, input.reasonText ?? null)}${input.mode === 'live'
      ? `They still go, at up to ${plural(input.dailyCap, 'email', 'emails')} a day; the rest wait their turn.`
      : `No marketing emails go until you are live; then they go at up to ${plural(input.dailyCap, 'email', 'emails')} a day.`} This lifts by itself after ${LADDER.recoverMinDays} clean days: bounces under ${LADDER.recoverBouncePercent}% (none, if you sent fewer than ${LADDER.minSendsForRate} emails that week) and fewer than ${LADDER.slowedComplaints} spam reports in ${LADDER.complaintWindowDays} days. Remove addresses that bounced and only email people who asked to hear from you.` };
  if (input.mode === 'live' && (input.sampleState === 'sending' || input.sampleState === 'waiting')) return { tone: 'ok', title: 'Your first emails go first',
    text: `Your first ${SAMPLE.size} marketing emails go first, then we wait ${SAMPLE.waitHours} hours to check how many bounced or were marked as spam. If no more than 1 bounced and nobody marked one as spam, the rest go by themselves; until then they wait.` };
  return null;
}

/** One founder line for Today, with its one button. */
export interface FounderLine { readonly tone: 'red' | 'amber'; readonly sentence: string; readonly button: string; readonly kind: string; readonly workspaceId: string | null }

export function founderLine(input: { kind: string; businessName: string; trip: Trip | null; domain?: string | null }): FounderLine | null {
  const b = input.businessName, what = founderTripped(input.trip);
  switch (input.kind) {
    case 'paused': return { tone: 'red', kind: 'paused', workspaceId: null, button: 'Review and decide',
      sentence: `Emails paused for ${b}. ${what ? `${what} ` : ''}Sign-in and booking emails still go. Nobody else is affected.` };
    case 'switched_off': return { tone: 'red', kind: 'switched_off', workspaceId: null, button: 'Review and decide',
      sentence: `Email switched off for ${b}: paused twice within ${LADDER.secondPauseDays} days. ${what ? `${what} ` : ''}Sign-in and booking emails still go.` };
    case 'go_live_requested': return { tone: 'amber', kind: 'go_live_requested', workspaceId: null, button: 'Approve',
      sentence: input.domain ? `${b} is ready to go live, sending from ${input.domain}.` : `${b} is ready to go live.` };
    case 'sample_held': return { tone: 'red', kind: 'sample_held', workspaceId: null, button: 'Let the rest go',
      sentence: `${b} sent its first ${SAMPLE.size} emails to a list and the rest is held. ${what}` };
    case 'account_held': return { tone: 'red', kind: 'account_held', workspaceId: null, button: 'See what happened',
      sentence: `The whole account is getting close to Postmark's limit. ${what ? `${what} ` : ''}Marketing emails are on hold for every business.` };
    default: return null;
  }
}

/** The emails. Subject and plain text (the HTML is the same text, escaped, with the one link). */
export interface AlertEmail { readonly subject: string; readonly text: string; readonly link: string; readonly linkLabel: string }

export function ownerAlertEmail(input: { kind: string; businessName: string; trip: Trip | null; dailyCap?: number; pageUrl: string }): AlertEmail | null {
  const b = input.businessName, what = ownerTripped(input.trip), link = input.pageUrl;
  const close = 'If you have a question, reply to this email.';
  switch (input.kind) {
    case 'slowed': return { subject: `We have slowed ${b}'s marketing emails`, link, linkLabel: 'See your email page',
      text: `${what}\n\nYour marketing emails still go, at up to ${plural(input.dailyCap ?? 0, 'email', 'emails')} a day. This lifts by itself after ${LADDER.recoverMinDays} clean days.\n\nTo help: remove addresses that bounced and only email people who asked to hear from you.\n\n${close}` };
    case 'paused': return { subject: `${b}'s marketing emails are paused`, link, linkLabel: 'See your email page',
      text: `${what}\n\n${STILL_GOES} No other business is affected. Your marketing emails are waiting and will go when we restart them.\n\nTo restart: remove the addresses that bounced or complained and check where your newest addresses came from, then reply to this email. Only we can restart it. ${accountCaused(input.trip)
        ? 'This pause came from our shared account\'s limit, so it does not count toward switching your email off.' : `A second pause within ${LADDER.secondPauseDays} days switches your email off.`}` };
    case 'switched_off': return { subject: `${b}'s email sending is switched off`, link, linkLabel: 'See your email page',
      text: `${what ? `${what}\n\n` : ''}Your marketing emails were paused twice within ${LADDER.secondPauseDays} days, so email sending is switched off to protect everyone who sends through our shared account.\n\n${STILL_GOES}\n\nOnly we can switch it back on. Reply to this email to ask for a review.` };
    case 'sample_held': return { subject: `We have held the rest of ${b}'s list`, link, linkLabel: 'See your email page',
      text: `${what}\n\nThe rest of this list is waiting: nothing else from it goes until it is cleaned. Remove old, bought or guessed addresses, then reply to this email and we will let the rest go.\n\n${STILL_GOES}` };
    case 'go_live_approved': return { subject: `${b} is live`, link, linkLabel: 'See your email page',
      text: `Your email is approved and live. Your first ${SAMPLE.size} marketing emails go first, then we wait ${SAMPLE.waitHours} hours to check how many bounced or were marked as spam; if that is within our limit, the rest go by themselves.\n\nNew senders start at ${RAMP_START} marketing emails a day. The limit steps up only after busy, clean days (enough emails sent, bounces under 2% and no spam reports), to 2,000 a day after four weeks at the soonest.\n\n${close}` };
    case 'lifted': case 'reinstated': return { subject: `${b}'s marketing emails are going again`, link, linkLabel: 'See your email page',
      text: `We have restarted your marketing emails. They start slowly (half your usual daily limit) and your next ${SAMPLE.size} emails go first while we check them.\n\nPlease keep only people who asked to hear from you on your lists. Another pause within ${LADDER.secondPauseDays} days, once at least ${RESTART_MIN_SENDS_FOR_OFF} more emails have gone, switches email off.` };
    case 'sample_released': return { subject: `We have let ${b}'s list go`, link, linkLabel: 'See your email page',
      text: `The rest of your list can go now. The next ${SAMPLE.size} emails go first while we check them again.\n\n${close}` };
    default: return null;
  }
}
const RAMP_START = 50;

export function founderAlertEmail(input: { kind: string; businessName: string; trip: Trip | null; pageUrl: string; domain?: string | null }): AlertEmail | null {
  const line = founderLine(input);
  if (!line) return null;
  const subject = input.kind === 'go_live_requested' ? `${input.businessName} is ready to go live${input.domain ? ` (${input.domain})` : ''}`
    : input.kind === 'account_held' ? 'Marketing emails are on hold for every business' : line.sentence.split('. ')[0]!;
  return { subject, text: line.sentence, link: input.pageUrl, linkLabel: line.button };
}

export const ACCOUNT_LINES_TEXT = `Account lines: bounces ${ACCOUNT.watchBouncePercent}% (worst offender paused) and ${ACCOUNT.holdBouncePercent}% (every business held) over 7 days; spam reports 1 in ${num(10_000 / ACCOUNT.watchComplaintsPerTenThousand)} and 1 in ${num(10_000 / ACCOUNT.holdComplaintsPerTenThousand)} over 30 days; from ${num(ACCOUNT.minSends)} emails.`;
