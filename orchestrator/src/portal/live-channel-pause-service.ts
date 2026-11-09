import type { PortalCrmRequestIdentity } from './crm-service.js';
import type { PortalLiveChannelTruthRail } from './live-channel-truth-service.js';

export type PortalLiveChannelPauseScope = PortalLiveChannelTruthRail | 'all';

export type PortalLiveChannelPauseOutcome = Readonly<{
  ok: true;
  disposition: 'engaged' | 'replayed';
  scope: PortalLiveChannelPauseScope;
}> | Readonly<{
  ok: false;
  kind: 'unauthenticated' | 'forbidden' | 'validation' | 'unavailable';
}>;

/** Engage-only command. Deliberately exposes no release/resume operation. */
export interface PortalLiveChannelPauseService {
  engage(
    identity: PortalCrmRequestIdentity,
    input: Readonly<{ scope: PortalLiveChannelPauseScope; commandKey: string }>,
  ): Promise<PortalLiveChannelPauseOutcome>;
}
