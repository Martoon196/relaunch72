import { createHash } from 'node:crypto';
import {
  canonicalCompanyContentEmailDraft, canonicalCompanyContentJson, parseCompanyContentEmailDraft,
  type CreateCompanyContentEmailDraftVersionCommand,
} from '../company-content-pg/index.js';
import { MhpCommerceError } from './commerce-service.js';
import { MHP_SITE_ORIGIN } from './growth-service.js';
import { MHP_MARKETING_WORKSPACE_ID } from './marketing-workspace-service.js';
import { MHP_MARKETING_TEMPLATES } from './marketing-templates.js';

export const MHP_OWNER_EMAIL_SOURCE = 'mhp.owner-email';
export const MHP_OWNER_EMAIL_ORGANIZATION = 'ba41b1a4-9752-4dbf-8312-d04a0f03d0b8';
export const MHP_OWNER_EMAIL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const MHP_WEBINAR_EMAIL_STEPS = ['webinar_confirm', 'webinar_24h', 'webinar_1h', 'webinar_replay', 'webinar_followup'] as const;
export type MhpWebinarEmailStep = typeof MHP_WEBINAR_EMAIL_STEPS[number];
export const mhpEmailSha = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const escape = (value: string): string => value.replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export interface MhpOwnerEmailBrand {
  canonical: string;
  sha256: string;
  ref: string;
  productName: string;
  primaryColor: string | null;
  accentColor: string | null;
}

/** Hash the exact database snapshot bytes; never substitute PP branding. */
export function parseMhpOwnerEmailBrand(value: unknown): MhpOwnerEmailBrand {
  if (!isRecord(value) || typeof value.canonical !== 'string' || Buffer.byteLength(value.canonical) > 12_000
      || typeof value.sha256 !== 'string' || mhpEmailSha(value.canonical) !== value.sha256
      || value.ref !== `mhp:organization-branding:${MHP_OWNER_EMAIL_ORGANIZATION}:${value.sha256}`) {
    throw new MhpCommerceError(503, 'The MHP brand details could not be verified.');
  }
  let snapshot: unknown;
  try { snapshot = JSON.parse(value.canonical); } catch { snapshot = null; }
  if (!isRecord(snapshot) || snapshot.schema !== 'mhp.organization-branding/v1'
      || snapshot.organizationId !== MHP_OWNER_EMAIL_ORGANIZATION
      || typeof snapshot.productName !== 'string' || snapshot.productName.length < 1 || snapshot.productName.length > 100
      || typeof snapshot.revision !== 'string' || !Number.isFinite(Date.parse(snapshot.revision))
      || ![snapshot.primaryColor, snapshot.accentColor].every(color => color === null || (typeof color === 'string' && /^#[0-9a-f]{6}$/iu.test(color)))) {
    throw new MhpCommerceError(503, 'The MHP brand details could not be verified.');
  }
  return { canonical: value.canonical, sha256: value.sha256, ref: value.ref,
    productName: snapshot.productName, primaryColor: snapshot.primaryColor as string | null, accentColor: snapshot.accentColor as string | null };
}

export function validateMhpOwnerEmailCopy(subject: string, bodyText: string): string {
  if (Buffer.byteLength(bodyText, 'utf8') > 50_000) throw new MhpCommerceError(400, 'Keep the email body within 50,000 bytes.');
  const withoutFields = `${subject}\n${bodyText}`.replace(/\{\{(?:FIRSTNAME|LABEL|LINK|UNSUBSCRIBE)\}\}/gu, '');
  if (withoutFields.includes('{{') || withoutFields.includes('}}')) {
    throw new MhpCommerceError(400, 'Use only FIRSTNAME, LABEL, LINK or UNSUBSCRIBE in double braces.');
  }
  try { return canonicalCompanyContentEmailDraft(subject, bodyText); }
  catch { throw new MhpCommerceError(400, 'Use a subject on one line and a non-empty text email body.'); }
}

export function mhpOwnerEmailDraftCommand(input: {
  commandId: string; title: string; subject: string; bodyText: string; campaign: string; brand: MhpOwnerEmailBrand; now: number;
  previous?: { contentItemId: string; contentVersionId: string; sourceItemId: string };
}): CreateCompanyContentEmailDraftVersionCommand {
  if (!MHP_OWNER_EMAIL_UUID.test(input.commandId) || !/^[a-z0-9_-]{1,60}$/u.test(input.campaign)
      || input.title !== input.title.trim() || input.title.length < 1 || input.title.length > 300) {
    throw new MhpCommerceError(400, 'Give this email a title and refresh the editor before saving.');
  }
  if (input.previous && (!MHP_OWNER_EMAIL_UUID.test(input.previous.contentItemId)
      || !MHP_OWNER_EMAIL_UUID.test(input.previous.contentVersionId) || !/^owner-email:[0-9a-f-]{36}$/u.test(input.previous.sourceItemId))) {
    throw new MhpCommerceError(400, 'Refresh the saved email before editing.');
  }
  const canonical = validateMhpOwnerEmailCopy(input.subject, input.bodyText);
  const digest = mhpEmailSha(canonical), sourceItemId = input.previous?.sourceItemId ?? `owner-email:${input.commandId}`;
  const sourceVersion = `edit:${input.commandId}`, storageKey = `inline:mhp.owner-email:${digest}`;
  const manifestCanonical = canonicalCompanyContentJson({ schema: 'mhp.owner-email-source/v1',
    workspaceId: MHP_MARKETING_WORKSPACE_ID, sourceSystem: MHP_OWNER_EMAIL_SOURCE, sourceItemId, sourceVersion,
    contentSha256: digest, blobStorageKey: storageKey, blobSha256: digest,
    brandSnapshotRef: input.brand.ref, brandSha256: input.brand.sha256, audienceCampaign: input.campaign });
  return {
    commandKey: `mhp.owner-email.save.${input.commandId}`,
    contentItemId: input.previous?.contentItemId ?? null, previousVersionId: input.previous?.contentVersionId ?? null,
    origin: input.previous ? 'edited' : 'imported', title: input.title, subject: input.subject, bodyText: input.bodyText,
    source: { system: MHP_OWNER_EMAIL_SOURCE, itemId: sourceItemId, version: sourceVersion },
    blob: { storageKey, sha256: digest }, brand: { snapshotRef: input.brand.ref, sha256: input.brand.sha256 },
    attestation: { catalogSha256: mhpEmailSha(manifestCanonical), checkedAt: new Date(input.now).toISOString(), expiresAt: new Date(input.now + 15 * 60_000).toISOString() },
    metadata: { mhpOwnerEmail: { schema: 'mhp.owner-email-local/v1', brandCanonical: input.brand.canonical,
      manifestCanonical, manifestSha256: mhpEmailSha(manifestCanonical), authoredBy: 'native-owner' } },
  };
}

/** Existing approved code copy is a starting point; it does not edit automatic sends. */
export function mhpOwnerEmailSeed(step: string): { title: string; subject: string; bodyText: string } {
  if (!MHP_WEBINAR_EMAIL_STEPS.includes(step as MhpWebinarEmailStep)) throw new MhpCommerceError(400, 'Choose an existing webinar email.');
  const template = MHP_MARKETING_TEMPLATES[step as MhpWebinarEmailStep];
  const label = { webinar_confirm: 'Webinar confirmation', webinar_24h: 'Day-before reminder', webinar_1h: 'One-hour reminder',
    webinar_replay: 'Webinar replay', webinar_followup: 'Webinar follow-up' }[step as MhpWebinarEmailStep];
  return { title: `${label} — owner copy`, subject: template.subject, bodyText: template.text };
}

export interface MhpOwnerEmailRendered { subject: string; text: string; html: string; unsubscribe: string }

export function renderMhpOwnerEmail(input: { canonicalContent: string; contentSha256: string; brand: MhpOwnerEmailBrand;
  firstName: string | null; label: string; link: string; unsubscribe: string; preview?: boolean }): MhpOwnerEmailRendered {
  if (mhpEmailSha(input.canonicalContent) !== input.contentSha256) throw new Error('Owner email content digest mismatch');
  const brand = parseMhpOwnerEmailBrand(input.brand);
  const unsubscribeUrl = new URL(input.unsubscribe);
  if (!input.preview && (unsubscribeUrl.origin !== 'https://app.martinhowardproperty.co.uk'
      || unsubscribeUrl.pathname !== '/email/unsubscribe' || unsubscribeUrl.username || unsubscribeUrl.password)) {
    throw new Error('Owner email unsubscribe link is invalid');
  }
  const copy = parseCompanyContentEmailDraft(input.canonicalContent);
  validateMhpOwnerEmailCopy(copy.subject, copy.bodyText);
  let link: string;
  try { const url = new URL(input.link); link = url.origin === MHP_SITE_ORIGIN && !url.username && !url.password ? url.href : `${MHP_SITE_ORIGIN}/webinar/`; }
  catch { link = `${MHP_SITE_ORIGIN}/webinar/`; }
  const values: Record<string, string> = { FIRSTNAME: (input.firstName ?? '').trim().split(/\s+/u)[0]?.slice(0, 60) || 'there',
    LABEL: input.label.slice(0, 200), LINK: link, UNSUBSCRIBE: input.unsubscribe };
  const fill = (value: string) => value.replace(/\{\{(FIRSTNAME|LABEL|LINK|UNSUBSCRIBE)\}\}/gu,
    (_match, name: string) => values[name]!.replace(/[\r\n]+/gu, ' '));
  const subject = `${input.preview ? '[TEST] ' : ''}${fill(copy.subject)}`;
  const body = fill(copy.bodyText);
  const footer = input.preview ? 'Owner preview only. This email has not been sent to your webinar audience.' : `Unsubscribe: ${input.unsubscribe}`;
  const text = `${body}\n\n${footer}`;
  const color = brand.primaryColor ?? '#142019';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escape(subject)}</title></head><body style="margin:0;background:#f5f3ed;color:#142019;font:16px/1.7 Arial,sans-serif"><main style="max-width:640px;margin:auto;padding:32px;background:#fff"><h1 style="font-size:20px;color:${escape(color)}">${escape(brand.productName)}</h1><div style="white-space:pre-wrap;overflow-wrap:anywhere">${escape(body)}</div><p style="margin-top:32px;font-size:12px">${input.preview ? escape(footer) : `<a href="${escape(input.unsubscribe)}">Unsubscribe</a>`}</p></main></body></html>`;
  return { subject, text, html, unsubscribe: input.unsubscribe };
}
