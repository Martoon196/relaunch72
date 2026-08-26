import type { PlatformModuleId } from '../platform/modules.js';

export type PortalProductProfileId = 'relaunch72' | 'property_predator_growth';

export interface PortalThemeTokens {
  canvas: string;
  panel: string;
  panelSubtle: string;
  panelStrong: string;
  ink: string;
  muted: string;
  faint: string;
  line: string;
  lineStrong: string;
  accent: string;
  accentDeep: string;
  accentSoft: string;
  nav: string;
  navRaised: string;
  navLine: string;
  navText: string;
  navMuted: string;
}

export interface PortalJourneyBlueprint {
  /** Stable installation slug used by the PostgreSQL journey publisher. */
  id: 'property-predator-self-serve' | 'property-predator-agency-laps';
  label: string;
  summary: string;
  milestones: readonly string[];
}

export interface PortalReadinessRail {
  id: 'content' | 'social' | 'inbox' | 'webinars' | 'journeys' | 'automations';
  label: string;
  summary: string;
  state: 'foundation' | 'reuse' | 'planned';
  href?: string;
}

export interface PortalContentWorkspaceNavigation {
  readonly brainRoute: '/portal/content/brain';
  readonly brainLabel: string;
  readonly brainSummary: string;
}

export interface PortalProductProfile {
  id: PortalProductProfileId;
  productName: string;
  compactMark: string;
  suiteLabel: string;
  home: {
    eyebrow: string;
    title: string;
    summary: string;
  };
  auth: {
    lead: string;
    storyKicker: string;
    storyTitle: string;
    storyBody: string;
  };
  theme: PortalThemeTokens;
  visibleNavigation: readonly PlatformModuleId[];
  moduleLabels: Readonly<Partial<Record<PlatformModuleId, string>>>;
  journeyBlueprints: readonly PortalJourneyBlueprint[];
  readinessRails: readonly PortalReadinessRail[];
  /** Product-owned nested content navigation; presentation only, never authority. */
  contentWorkspace?: PortalContentWorkspaceNavigation;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const SAFE_TEXT = /^[^<>]{1,240}$/;

function checkedText(value: string, label: string): string {
  const text = value.trim();
  if (!SAFE_TEXT.test(text)) throw new Error(`${label} contains unsafe or empty text`);
  return text;
}

function checkedHref(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) {
      throw new Error('unsafe URL');
    }
    return url.toString();
  } catch {
    throw new Error(`${label} must be an absolute HTTPS URL`);
  }
}

function checkedTheme(theme: PortalThemeTokens): Readonly<PortalThemeTokens> {
  for (const [name, value] of Object.entries(theme)) {
    if (!HEX_COLOR.test(value)) throw new Error(`product profile theme ${name} must be a six-digit hex colour`);
  }
  return Object.freeze({ ...theme });
}

function createProfile(profile: PortalProductProfile): PortalProductProfile {
  const moduleLabels = Object.freeze(Object.fromEntries(
    Object.entries(profile.moduleLabels).map(([id, label]) => [id, checkedText(label!, `module label ${id}`)]),
  ));
  const journeyBlueprints = Object.freeze(profile.journeyBlueprints.map((journey) => Object.freeze({
    ...journey,
    label: checkedText(journey.label, `journey ${journey.id} label`),
    summary: checkedText(journey.summary, `journey ${journey.id} summary`),
    milestones: Object.freeze(journey.milestones.map((milestone) => checkedText(milestone, `journey ${journey.id} milestone`))),
  })));
  const readinessRails = Object.freeze(profile.readinessRails.map((rail) => {
    const href = checkedHref(rail.href, `readiness rail ${rail.id} href`);
    return Object.freeze({
      ...rail,
      label: checkedText(rail.label, `readiness rail ${rail.id} label`),
      summary: checkedText(rail.summary, `readiness rail ${rail.id} summary`),
      ...(href ? { href } : {}),
    });
  }));
  const contentWorkspace = profile.contentWorkspace
    ? Object.freeze({
        brainRoute: profile.contentWorkspace.brainRoute,
        brainLabel: checkedText(profile.contentWorkspace.brainLabel, 'Brand Brain navigation label'),
        brainSummary: checkedText(profile.contentWorkspace.brainSummary, 'Brand Brain navigation summary'),
      })
    : undefined;
  if (contentWorkspace && contentWorkspace.brainRoute !== '/portal/content/brain') {
    throw new Error('Brand Brain navigation must use the canonical portal route');
  }
  return Object.freeze({
    ...profile,
    productName: checkedText(profile.productName, 'productName'),
    compactMark: checkedText(profile.compactMark, 'compactMark'),
    suiteLabel: checkedText(profile.suiteLabel, 'suiteLabel'),
    home: Object.freeze({
      eyebrow: checkedText(profile.home.eyebrow, 'home eyebrow'),
      title: checkedText(profile.home.title, 'home title'),
      summary: checkedText(profile.home.summary, 'home summary'),
    }),
    auth: Object.freeze({
      lead: checkedText(profile.auth.lead, 'auth lead'),
      storyKicker: checkedText(profile.auth.storyKicker, 'auth story kicker'),
      storyTitle: checkedText(profile.auth.storyTitle, 'auth story title'),
      storyBody: checkedText(profile.auth.storyBody, 'auth story body'),
    }),
    theme: checkedTheme(profile.theme),
    visibleNavigation: Object.freeze([...profile.visibleNavigation]),
    moduleLabels,
    journeyBlueprints,
    readinessRails,
    ...(contentWorkspace ? { contentWorkspace } : {}),
  });
}

export const RELAUNCH72_PRODUCT_PROFILE = createProfile({
  id: 'relaunch72',
  productName: 'RELAUNCH72',
  compactMark: 'R72',
  suiteLabel: 'Command centre',
  home: {
    eyebrow: 'Growth workspace',
    title: 'Turn attention into revenue.',
    summary: 'One calm view of the leads, opportunities and next actions already saved in this workspace.',
  },
  auth: {
    lead: 'Sign in to your private marketing workspace.',
    storyKicker: 'Your operating system',
    storyTitle: 'Build momentum. Keep control.',
    storyBody: 'Bring customer context, content and conversion work into one secure operating workspace.',
  },
  theme: {
    canvas: '#f4f6f8', panel: '#ffffff', panelSubtle: '#f8f9fb', panelStrong: '#edf1f5',
    ink: '#152033', muted: '#657187', faint: '#59677d', line: '#dfe4eb', lineStrong: '#cbd3df',
    accent: '#ed9c24', accentDeep: '#a45f08', accentSoft: '#fff3de',
    nav: '#101827', navRaised: '#182236', navLine: '#2a374b', navText: '#e8edf4', navMuted: '#8f9db0',
  },
  visibleNavigation: ['overview', 'crm', 'content', 'analytics', 'settings'],
  moduleLabels: { overview: 'Home', crm: 'CRM', content: 'Content', analytics: 'Reports', settings: 'Settings' },
  journeyBlueprints: [],
  readinessRails: [
    { id: 'content', label: 'Content engine', summary: 'On-brand drafts and approval.', state: 'foundation' },
    { id: 'social', label: 'Social publishing', summary: 'Scheduling and provider-confirmed outcomes.', state: 'planned' },
    { id: 'inbox', label: 'Shared inbox', summary: 'Email, WhatsApp and social conversations.', state: 'planned' },
    { id: 'webinars', label: 'Webinars', summary: 'Registration, attendance and follow-up.', state: 'planned' },
    { id: 'automations', label: 'Automations', summary: 'Guardrailed conversion recipes.', state: 'planned' },
  ],
});

export const PROPERTY_PREDATOR_GROWTH_PROFILE = createProfile({
  id: 'property_predator_growth',
  productName: 'PropertyPredator',
  compactMark: 'PP',
  suiteLabel: 'Growth HQ',
  home: {
    eyebrow: 'PropertyPredator · conversion command',
    title: 'See what every lead is hiding.',
    summary: 'Every signal. One evidence trail. The next move from first touch to paid conversion.',
  },
  auth: {
    lead: 'Sign in to the private PropertyPredator partner workspace.',
    storyKicker: 'Growth HQ',
    storyTitle: 'Find the signal. Work the next move.',
    storyBody: 'Property intelligence creates the opportunity. Growth HQ starts with the real leads and next moves that will anchor the route to a sale.',
  },
  theme: {
    canvas: '#050608', panel: '#111318', panelSubtle: '#0b0d11', panelStrong: '#161a21',
    ink: '#eef1f7', muted: '#9aa6ba', faint: '#6e7a90', line: '#1e2430', lineStrong: '#303949',
    accent: '#00e5cc', accentDeep: '#00e5cc', accentSoft: '#0a2c2c',
    nav: '#050608', navRaised: '#111318', navLine: '#1e2430', navText: '#eef1f7', navMuted: '#9aa6ba',
  },
  visibleNavigation: ['overview', 'actions', 'crm', 'journeys', 'content', 'inbox'],
  moduleLabels: {
    overview: 'Today', actions: 'Actions', crm: 'Leads', journeys: 'Journeys',
    content: 'Content', inbox: 'Inbox',
  },
  journeyBlueprints: [
    {
      id: 'property-predator-self-serve', label: 'Self-serve conversion',
      summary: 'From captured interest through meaningful product use and a genuine paid moment.',
      milestones: ['Lead', 'Activated', 'Priced', 'Sale'],
    },
    {
      id: 'property-predator-agency-laps', label: 'Agency LAPS',
      summary: 'The literal appointment-led route for agency pilots and higher-value sales.',
      milestones: ['Lead', 'Appointment', 'Presentation', 'Sale'],
    },
  ],
  readinessRails: [
    {
      id: 'journeys', label: 'Journey runtime',
      summary: 'Automatic enrolment, evidence-led advancement and explainable scores.',
      state: 'foundation',
    },
    {
      id: 'content',
      label: 'Affiliate Stash content machine',
      summary: 'Reuse its brand-trained generation, swipe library and artwork catalogue; Growth HQ will orchestrate reviewed items instead of rebuilding it.',
      state: 'foundation',
    },
    { id: 'social', label: 'Social machine', summary: 'Broad publishing with provider-confirmed outcomes.', state: 'planned' },
    { id: 'inbox', label: 'Conversion inbox', summary: 'Approval-led email, WhatsApp, SMS, Messenger and Instagram test rails.', state: 'foundation' },
    { id: 'webinars', label: 'Predator Briefing', summary: 'Live registration, attendance and follow-up journeys.', state: 'planned' },
    { id: 'automations', label: 'Conversion recipes', summary: 'Approval-led sequences with visible stop rules.', state: 'planned' },
  ],
  contentWorkspace: {
    brainRoute: '/portal/content/brain',
    brainLabel: 'Brand Brain',
    brainSummary: 'Inventory, governance and evaluation readiness for owned Property Predator AI specialists.',
  },
});

const PROFILES: Readonly<Record<PortalProductProfileId, PortalProductProfile>> = Object.freeze({
  relaunch72: RELAUNCH72_PRODUCT_PROFILE,
  property_predator_growth: PROPERTY_PREDATOR_GROWTH_PROFILE,
});

export function resolvePortalProductProfile(value?: string | null): PortalProductProfile {
  const id = value?.trim() || 'relaunch72';
  if (!Object.hasOwn(PROFILES, id)) throw new Error(`unknown portal product profile: ${id}`);
  return PROFILES[id as PortalProductProfileId];
}
