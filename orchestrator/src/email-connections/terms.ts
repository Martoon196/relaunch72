/**
 * The email rules a business agrees to before anything is created in the shared Postmark account. Every business
 * sends through our one account, so one business's bad sending would hurt everyone's delivery. Changing these rules
 * means a new EMAIL_TERMS_VERSION: the owner must tick again before any further Postmark call is made for them.
 */
export const EMAIL_TERMS_VERSION = '2026-11-14';

export const EMAIL_TERMS: readonly string[] = Object.freeze([
  'Only email people who asked to hear from you.',
  'No bought, borrowed, scraped or guessed lists.',
  'Every marketing email has an unsubscribe link and your real business name and address.',
  'Honest subject lines and sender name.',
  'Not for multi-level marketing, affiliate marketing, "make money online" offers or list selling.',
  'We may slow, pause or switch off your email to protect everyone who sends through us.',
]);

export const EMAIL_TERMS_AGREEMENT = 'I agree to these email rules';
