/**
 * The one existing workspace an owner may use for content instead of adding a new business (owner decision,
 * migration 0154): Martin Howard Property's live brand workspace, which already holds its CRM, webinars and email.
 * The database pins the same ids; these constants only decide what the page offers.
 */
export const EXISTING_WORKSPACE = Object.freeze({
  id: '2789228d-55a6-4688-b1e8-2f70abca990b',
  organizationId: 'ba41b1a4-9752-4dbf-8312-d04a0f03d0b8',
  name: 'Martin Howard Property',
});

const NAME_KEY = 'martinhowardproperty';

/**
 * Whether an "Add a business" entry is Martin Howard Property, so the ordinary form must not make a second, empty
 * workspace for it. The rule, kept deliberately simple: ignoring case, spaces and punctuation the name starts with
 * "Martin Howard Property" (so "Martin Howard Property Ltd" counts too), or the website's address has
 * "martinhowardproperty" as one of its dot-separated parts (martinhowardproperty.co.uk, www. or app. in front, or
 * another ending). Anything else is an ordinary new business.
 */
export function namesExistingWorkspace(name: string, website?: string | null): boolean {
  const key = name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (key.startsWith(NAME_KEY)) return true;
  const raw = (website ?? '').trim().toLowerCase();
  if (!raw) return false;
  const host = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/, 1)[0]!.replace(/^[^@]*@/, '').replace(/:\d*$/, '');
  return host.split('.').includes(NAME_KEY);
}
