export const IMAGE_STUDIO_ROUTE = '/portal/content/images' as const;

export interface ImageStudioSnapshot {
  readonly workspaceName: string;
  readonly capturedAt: string;
  readonly model: 'gpt-image-2';
  readonly credentialBoundary: 'property-predator-openai-image-api/v1';
  readonly effects: Readonly<{
    generationEnabled: boolean;
    providerEffectsEnabled: boolean;
    emergencyPaused: boolean;
    commandBoundaryAvailable: boolean;
  }>;
  readonly usage: Readonly<{
    dayUsed: number;
    dayLimit: number;
    concurrentUsed: number;
    concurrentLimit: number;
    monthSpendMinor: number;
    monthSpendLimitMinor: number;
    currency: 'USD';
  }>;
  readonly brand: Readonly<{
    profileLabel: string;
    profileSha256: string;
    rulesSha256: string;
    realLogoRequired: boolean;
    forbidden: readonly string[];
  }>;
  readonly brief: Readonly<{
    subject: string;
    forensicConcept: string;
    composition: string;
    intendedUse: 'article-hero' | 'social-background' | 'campaign-concept' | 'diagram-background';
    altText: string;
    size: '1024x1024' | '1536x1024' | '1024x1536';
    quality: 'low' | 'medium' | 'high';
    maximumCostMinor: number;
  }>;
  readonly references: readonly Readonly<{
    assetId: string;
    label: string;
    kind: 'logo' | 'approved-artwork';
    versionId: string;
    sha256: string;
    approved: boolean;
  }>[];
  readonly proposals: readonly Readonly<{
    proposalId: string;
    label: string;
    state: 'brand-review' | 'approval-ready' | 'changes-requested';
    operation: 'generate' | 'edit';
    shortHash: string;
    costMinor: number;
    createdAt: string;
  }>[];
}

export interface ImageStudioGaugeView {
  readonly used: number;
  readonly limit: number;
  readonly remaining: number;
  readonly percent: number;
  readonly label: string;
}

export interface ImageStudioView {
  readonly workspaceName: string;
  readonly capturedAt: string;
  readonly model: 'gpt-image-2';
  readonly credentialBoundary: string;
  readonly effects: ImageStudioSnapshot['effects'];
  readonly daily: ImageStudioGaugeView;
  readonly concurrency: ImageStudioGaugeView;
  readonly spend: ImageStudioGaugeView;
  readonly brand: ImageStudioSnapshot['brand'];
  readonly brief: ImageStudioSnapshot['brief'];
  readonly references: ImageStudioSnapshot['references'];
  readonly proposals: ImageStudioSnapshot['proposals'];
  readonly generateAvailable: boolean;
  readonly gateLabel: string;
  readonly gateDetail: string;
}

function boundedInteger(value: number, maximum = 1_000_000): number {
  if (!Number.isSafeInteger(value) || value < 0) return 0;
  return Math.min(value, maximum);
}

function gauge(usedRaw: number, limitRaw: number, label: string): ImageStudioGaugeView {
  const limit = Math.max(1, boundedInteger(limitRaw));
  const used = Math.min(limit, boundedInteger(usedRaw));
  return Object.freeze({
    used,
    limit,
    remaining: Math.max(0, limit - used),
    percent: Math.round((used / limit) * 100),
    label,
  });
}

function isSha256(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

export function presentImageStudio(snapshot: ImageStudioSnapshot): ImageStudioView {
  const daily = gauge(snapshot.usage.dayUsed, snapshot.usage.dayLimit, 'Daily generations');
  const concurrency = gauge(
    snapshot.usage.concurrentUsed,
    snapshot.usage.concurrentLimit,
    'Concurrent jobs',
  );
  const spend = gauge(
    snapshot.usage.monthSpendMinor,
    snapshot.usage.monthSpendLimitMinor,
    'Monthly image spend',
  );
  const exactBrand = isSha256(snapshot.brand.profileSha256)
    && isSha256(snapshot.brand.rulesSha256);
  const referencesApproved = snapshot.references.length > 0
    && snapshot.references.every((reference) => (
    reference.approved && isSha256(reference.sha256)
  ));
  const requiredRealLogoPresent = !snapshot.brand.realLogoRequired
    || snapshot.references.some((reference) => (
      reference.kind === 'logo' && reference.approved && isSha256(reference.sha256)
    ));
  const policyReady = snapshot.effects.generationEnabled
    && snapshot.effects.providerEffectsEnabled
    && !snapshot.effects.emergencyPaused
    && daily.remaining > 0
    && concurrency.remaining > 0
    && spend.remaining >= snapshot.brief.maximumCostMinor
    && exactBrand
    && referencesApproved
    && requiredRealLogoPresent;
  // This presenter has no authenticated POST action. Never trust a projected
  // capability bit to manufacture an executable command boundary in HTML.
  const commandBoundaryAvailable = false;
  const generateAvailable = policyReady && commandBoundaryAvailable;

  let gateLabel = 'Ready for a controlled proposal';
  let gateDetail = 'Generation can create a review-only proposal. Publishing still requires human approval.';
  if (snapshot.effects.emergencyPaused) {
    gateLabel = 'Emergency pause is ON';
    gateDetail = 'No provider request can leave Growth HQ until the founder deliberately clears the pause.';
  } else if (!snapshot.effects.providerEffectsEnabled || !snapshot.effects.generationEnabled) {
    gateLabel = 'Provider effects are OFF';
    gateDetail = 'The studio is a complete rehearsal surface; OpenAI calls remain dark.';
  } else if (!exactBrand || !referencesApproved || !requiredRealLogoPresent) {
    gateLabel = 'Brand evidence is incomplete';
    gateDetail = 'Exact hashes and approved company-owned references are required before generation.';
  } else if (daily.remaining === 0 || concurrency.remaining === 0 || spend.remaining < snapshot.brief.maximumCostMinor) {
    gateLabel = 'Fuel limiter engaged';
    gateDetail = 'A volume, concurrency or spend limit has been reached. No provider call is permitted.';
  } else if (!commandBoundaryAvailable) {
    gateLabel = 'Command boundary not connected';
    gateDetail = 'The provider policy may be ready, but this portal surface cannot create a request yet.';
  }

  return Object.freeze({
    workspaceName: snapshot.workspaceName.slice(0, 160),
    capturedAt: snapshot.capturedAt,
    model: snapshot.model,
    credentialBoundary: snapshot.credentialBoundary,
    effects: Object.freeze({ ...snapshot.effects, commandBoundaryAvailable }),
    daily,
    concurrency,
    spend,
    brand: Object.freeze({
      ...snapshot.brand,
      forbidden: Object.freeze(snapshot.brand.forbidden.slice(0, 16)),
    }),
    brief: Object.freeze({ ...snapshot.brief }),
    references: Object.freeze(snapshot.references.slice(0, 12).map((item) => Object.freeze({ ...item }))),
    proposals: Object.freeze(snapshot.proposals.slice(0, 12).map((item) => Object.freeze({ ...item }))),
    generateAvailable,
    gateLabel,
    gateDetail,
  });
}
