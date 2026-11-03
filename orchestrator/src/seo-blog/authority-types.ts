/** Bounded supplier evidence, not earned links or a promise of AI placement. */
export interface LinkGapQuery {
  readonly kind: 'link_gap';
  readonly brandId: string;
  readonly brandDomain: string;
  readonly competitors: readonly string[];
  readonly limit: number;
}
export interface MentionQuery {
  readonly kind: 'indexed_mentions';
  readonly brandId: string;
  readonly brandDomain: string;
  readonly brandName: string;
  readonly platform: 'google' | 'chat_gpt';
  readonly locationCode: number;
  readonly languageCode: string;
  readonly since: string;
  readonly until: string;
  readonly match: { readonly kind: 'domain_sources' } | { readonly kind: 'answer_phrase'; readonly phrase: string };
  readonly limit: number;
}
export type AuthorityQuery = LinkGapQuery | MentionQuery;
export interface AuthorityReceipt {
  readonly supplier: 'dataforseo';
  readonly inputSha256: string;
  readonly retrievedAt: string;
  readonly httpStatus: number | null;
  readonly responseCode: number | null;
  readonly taskCode: number | null;
  readonly taskId: string | null;
  readonly requestEchoVerified: boolean;
  /** Supplier-reported evidence, not an invoice or permission to spend. Never add both. */
  readonly reportedTotalCostUsd: number | null;
  readonly reportedTaskCostUsd: number | null;
}
export interface LinkGapCandidate {
  readonly kind: 'supplier_link_gap_candidate';
  readonly brandId: string;
  readonly id: string;
  readonly domain: string;
  readonly evidence: readonly {
    readonly competitor: string;
    readonly providerRank: number | null;
    readonly reportedBacklinks: number | null;
    readonly reportedSpamScore: number | null;
    readonly firstSeenAt: string | null;
  }[];
  readonly sourcePageVerified: false;
  readonly contactVerified: false;
}
export interface MentionSource {
  readonly url: string;
  readonly title: string | null;
  readonly reportedPosition: number | null;
}
export interface IndexedMentionObservation {
  readonly kind: 'supplier_indexed_mention';
  readonly brandId: string;
  readonly id: string;
  readonly platform: 'google' | 'chat_gpt';
  readonly reportedModel: string | null;
  readonly locationCode: number;
  readonly languageCode: string;
  readonly question: string | null;
  readonly answerExcerpt: string | null;
  readonly excerptTruncated: boolean;
  readonly firstRecordedAt: string | null;
  readonly lastUpdatedAt: string | null;
  readonly retrievedAt: string;
  readonly sources: readonly MentionSource[];
  readonly sourcesTruncated: boolean;
  readonly searchResults: readonly MentionSource[];
  readonly searchResultsTruncated: boolean;
  readonly phraseInExcerpt: boolean | null;
  readonly brandInReportedSources: boolean | null;
  readonly brandInSearchResults: boolean | null;
  readonly reportedAiSearchVolume: number | null;
  readonly consumerResultObserved: false;
  readonly referralTrafficMeasured: false;
}
export interface AuthoritySample<T> {
  readonly outcome: 'results' | 'empty' | 'unconfigured' | 'unsupported' | 'not_started' | 'provider_rejected' | 'outcome_unknown';
  readonly code: 'ok' | 'credentials_missing' | 'unsupported_market' | 'aborted' | 'provider_rejected' | 'transport_interrupted' | 'invalid_response' | 'response_limit';
  readonly scope: AuthorityQuery;
  readonly receipt: AuthorityReceipt;
  readonly items: readonly T[];
  readonly reportedTotal: number | null;
  readonly complete: boolean;
}
export type AuthorityEvidence<T> = Readonly<{ state: 'unknown' }> | Readonly<{
  state: 'observed'; value: T; sourceUrl: string; observedAt: string;
}>;
export interface AuthorityProspect {
  readonly brandId: string;
  readonly pageUrl: string;
  readonly channel: 'editorial_outreach' | 'reddit' | 'quora';
  readonly topicalRelevance: AuthorityEvidence<boolean>;
  readonly pageContextVerified: AuthorityEvidence<boolean>;
  readonly monthlyVisits: AuthorityEvidence<number>;
  readonly spamScore: AuthorityEvidence<number>;
  readonly contactVerified: AuthorityEvidence<boolean>;
  readonly paidOrExchangedLink: AuthorityEvidence<boolean>;
}
export interface AuthorityQualification {
  readonly rulesVersion: 'r72-authority-qualification-v1';
  readonly id: string;
  readonly status: 'excluded' | 'needs_evidence' | 'review_ready' | 'community_hold';
  readonly reasons: readonly string[];
  readonly unknownFacts: readonly string[];
  readonly sendingAllowed: false;
}
