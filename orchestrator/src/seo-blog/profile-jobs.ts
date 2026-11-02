/** Profile generation is a write stage; existing unstaged writes remain article jobs. */
import type { ExtractedProfile } from './generation.js';
import type { ActivityEvent, Brand, BrandProfile, GenerationRecord, Job, KnowledgeDocument, KnowledgeRef, UsageRecord } from './types.js';

export interface ProfileJobReceipt {
  readonly nonce: string;
  readonly value: ExtractedProfile;
  readonly generation: GenerationRecord;
  readonly receivedAt: string;
}
export interface ProfileJobPayload {
  readonly stage: 'profile';
  readonly requestedBy: string;
  readonly requestIds: readonly string[];
  readonly inputSha: string;
  readonly source: { readonly brandName: string; readonly website: string | null; readonly knowledge: readonly KnowledgeRef[]; readonly prompt: { readonly version: string; readonly sha256: string; readonly model: string } };
  readonly baseVersion: number;
  readonly baseProfileSha: string;
  readonly acknowledgedPriorUsage: readonly string[];
  readonly start?: { readonly nonce: string; readonly at: string };
  /** Receipt and actual usage are committed together, exactly once per start nonce. */
  readonly receipt?: ProfileJobReceipt;
  readonly resultVersion?: number;
  readonly reason?: string;
}
export function isProfileJob(job: Job): boolean { return job.kind === 'write' && job.payload.stage === 'profile'; }
export function profilePayload(job: Job): ProfileJobPayload { return job.payload as unknown as ProfileJobPayload; }
export function unacknowledgedProfileCalls(jobs: readonly Job[]): Job[] {
  const profiles = jobs.filter(isProfileJob);
  const acknowledged = new Set(profiles.flatMap((j) => profilePayload(j).acknowledgedPriorUsage));
  return profiles.filter((j) => profilePayload(j).start && !profilePayload(j).receipt && !acknowledged.has(j.id));
}
export interface ProfileJobSnapshot {
  readonly brand: Brand;
  readonly profile: BrandProfile | null;
  readonly knowledge: readonly KnowledgeDocument[];
  readonly jobs: readonly Job[];
  readonly job: Job | null;
  readonly requesterAllowed: boolean;
  readonly modelTokensUsed: number;
}
export interface ProfileJobDecision {
  readonly job: Job;
  /** False returns an existing receipt without mutating it. */
  readonly write: boolean;
  readonly profile?: BrandProfile;
  readonly usage?: UsageRecord;
  readonly event?: ActivityEvent;
}
export interface ProfileJobBoundaryInput {
  readonly brandId: string;
  readonly jobId: string;
  readonly requesterId: string;
  readonly now: string;
  readonly decide: (snapshot: ProfileJobSnapshot) => ProfileJobDecision;
}
