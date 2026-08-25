/**
 * Stable product capabilities. Modules and provider adapters depend on these
 * contracts instead of importing one another, so new channels can be added
 * without turning the portal into a web of feature-specific conditionals.
 */
export const PLATFORM_CAPABILITIES = [
  'workspace.overview.read',
  'crm.contacts.read',
  'crm.contacts.write',
  'crm.pipeline.read',
  'crm.pipeline.write',
  'crm.tasks.read',
  'crm.tasks.write',
  'journeys.read',
  'journeys.manage',
  'content.drafts.read',
  'content.drafts.generate',
  'social.publish',
  'social.listen',
  'conversations.read',
  'conversations.reply',
  'channel.whatsapp',
  'webinars.manage',
  'automations.manage',
  'analytics.read',
  'billing.read',
] as const;

export type PlatformCapability = (typeof PLATFORM_CAPABILITIES)[number];

export function isPlatformCapability(value: string): value is PlatformCapability {
  return (PLATFORM_CAPABILITIES as readonly string[]).includes(value);
}
