import type { DatabaseRequestContext } from '../db/rls.js';

export type ContactPointKind = 'email' | 'phone' | 'whatsapp' | 'social' | 'other';
export type ContactPointConsent = 'unknown' | 'opted_in' | 'opted_out';
export type OpportunityStatus = 'open' | 'won' | 'lost';

export interface LeadContactPointInput {
  kind: ContactPointKind;
  value: string;
  label?: string | null;
  isPrimary?: boolean;
  consentStatus?: ContactPointConsent;
}

export interface LeadTaskInput {
  title: string;
  description?: string | null;
  assigneeUserId?: string | null;
  dueAt?: string | null;
}

export interface CreateLeadCommand {
  commandKey: string;
  displayName: string;
  companyName?: string | null;
  source?: string | null;
  ownerUserId?: string | null;
  contactPoints: readonly LeadContactPointInput[];
  pipelineId: string;
  stageId: string;
  opportunityName?: string | null;
  valueMinor?: number;
  currency?: string;
  task?: LeadTaskInput | null;
}

export interface CreateLeadResult {
  disposition: 'applied' | 'replayed';
  contactId: string;
  opportunityId: string;
  taskId: string | null;
  createdContact: boolean;
}

export interface MoveOpportunityStageCommand {
  commandKey: string;
  opportunityId: string;
  targetStageId: string;
  expectedRowVersion: number;
  note?: string | null;
}

export interface MoveOpportunityStageResult {
  disposition: 'applied' | 'replayed';
  opportunityId: string;
  fromStageId: string;
  toStageId: string;
  status: OpportunityStatus;
  rowVersion: number;
}

export interface CompleteTaskCommand {
  commandKey: string;
  taskId: string;
  expectedRowVersion: number;
}

export interface CompleteTaskResult {
  disposition: 'applied' | 'replayed';
  taskId: string;
  completedAt: string;
  rowVersion: number;
}

export interface SqlResult<TRow> {
  rows: TRow[];
  rowCount: number | null;
}

/** A deliberately tiny transaction-bound surface, implemented by pg or a unit-test fake. */
export interface SqlExecutor {
  query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<SqlResult<TRow>>;
}

export interface CrmTransactionRunner {
  run<T>(
    context: DatabaseRequestContext,
    operation: (transaction: SqlExecutor) => Promise<T>,
  ): Promise<T>;
}

export interface CrmCommandDependencies {
  transactionRunner: CrmTransactionRunner;
  nextId?: () => string;
  now?: () => Date;
}
