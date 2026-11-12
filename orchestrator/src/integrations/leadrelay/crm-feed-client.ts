/**
 * The smallest possible LeadRelay client for the CRM feed: read the undelivered event list, read one lead,
 * and mark one event as delivered. Nothing else is reachable through it.
 *
 * - Only GET /api/outbox, GET /api/leads/{id} and POST /api/outbox/{id}/ack are ever sent.
 * - The workspace key goes in the Authorization header only. No Origin header is sent (LeadRelay refuses
 *   service keys that carry one), no cookies, no request body.
 * - Every request has a deadline and a response size limit.
 * - Errors carry only a category and an HTTP status: never a response body, a name, an address or the key.
 */

import * as https from 'node:https';
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';

export const LEADRELAY_FEED_USER_AGENT = 'Relaunch72-LeadRelay-CRM-Feed/1.0';
/** LeadRelay serves at most 200 undelivered events per read. */
export const LEADRELAY_OUTBOX_PAGE = 200;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const ID = /^[A-Za-z0-9-]{1,64}$/u;

export type LeadRelayFeedErrorKind = 'unreachable' | 'unauthorised' | 'not_found' | 'unexpected_answer';
export class LeadRelayFeedError extends Error {
  constructor(readonly kind: LeadRelayFeedErrorKind, readonly status: number | null = null) {
    super(`LeadRelay ${kind}${status === null ? '' : ` (${status})`}`);
    this.name = 'LeadRelayFeedError';
  }
}

export interface LeadRelayOutboxRow {
  readonly id: string;
  readonly workspaceId: string | null;
  readonly kind: string;
  readonly leadId: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Epoch seconds, as LeadRelay stores it. */
  readonly createdAt: number;
}
/** A row whose id is usable but whose other fields could not be read. It can be acknowledged, never interpreted. */
export interface LeadRelayUnreadableRow { readonly id: string; readonly unreadable: true; readonly createdAt: number }

export interface LeadRelayLead {
  readonly id: string;
  readonly workspaceId: string | null;
  readonly name: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly company: string;
  readonly source: string;
  readonly isDemo: boolean;
}

export interface LeadRelayFeedClient {
  outbox(): Promise<(LeadRelayOutboxRow | LeadRelayUnreadableRow)[]>;
  /** null when LeadRelay no longer has the lead (for example it was erased). */
  lead(id: string): Promise<LeadRelayLead | null>;
  ack(id: string): Promise<void>;
}

export type RequestFunction = (url: URL, options: RequestOptions, callback: (res: IncomingMessage) => void) => ClientRequest;

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const optionalText = (value: unknown, max: number): string | null => typeof value === 'string' && value.length <= max ? value : null;

export function isLeadRelayId(value: unknown): value is string { return typeof value === 'string' && ID.test(value); }

function parseRow(value: unknown): LeadRelayOutboxRow | LeadRelayUnreadableRow | null {
  if (!record(value) || !isLeadRelayId(value.id)) return null;
  const createdAt = typeof value.created_at === 'number' && Number.isFinite(value.created_at) ? Math.trunc(value.created_at) : 0;
  const leadId = value.lead_id === null || value.lead_id === undefined ? null : isLeadRelayId(value.lead_id) ? value.lead_id : undefined;
  const workspaceId = value.workspace_id === undefined || value.workspace_id === null ? null
    : isLeadRelayId(value.workspace_id) ? value.workspace_id : undefined;
  if (typeof value.kind !== 'string' || !/^[a-z][a-z0-9_.]{0,79}$/u.test(value.kind) || !record(value.payload)
      || leadId === undefined || workspaceId === undefined || createdAt <= 0) {
    return { id: value.id, unreadable: true, createdAt };
  }
  return { id: value.id, workspaceId, kind: value.kind, leadId, payload: value.payload, createdAt };
}

function parseLead(value: unknown, id: string): LeadRelayLead {
  const lead = record(value) ? value.lead : undefined;
  if (!record(lead) || lead.id !== id || typeof lead.name !== 'string') throw new LeadRelayFeedError('unexpected_answer');
  const workspaceId = lead.workspace_id === undefined || lead.workspace_id === null ? null
    : isLeadRelayId(lead.workspace_id) ? lead.workspace_id : undefined;
  if (workspaceId === undefined) throw new LeadRelayFeedError('unexpected_answer');
  return {
    id, workspaceId, name: lead.name.slice(0, 200),
    email: optionalText(lead.email, 320), phone: optionalText(lead.phone, 32),
    company: optionalText(lead.company, 200) ?? '', source: optionalText(lead.source, 160) ?? '',
    isDemo: lead.is_demo === true,
  };
}

export function createLeadRelayFeedClient(input: { baseUrl: string; key: string; timeoutMs?: number; request?: RequestFunction }): LeadRelayFeedClient {
  const base = new URL(input.baseUrl);
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const send: RequestFunction = input.request ?? ((url, options, callback) => https.request(url, options, callback));

  function call(method: 'GET' | 'POST', path: string): Promise<{ status: number; body: unknown }> {
    const url = new URL(path, base);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error: LeadRelayFeedError | null, value?: { status: number; body: unknown }) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error) reject(error); else resolve(value!);
      };
      // Only these headers are ever sent. Node adds Host and Connection; it never adds Origin or Cookie.
      const headers: Record<string, string> = {
        authorization: `Bearer ${input.key}`, accept: 'application/json', 'user-agent': LEADRELAY_FEED_USER_AGENT,
        ...(method === 'POST' ? { 'content-length': '0' } : {}),
      };
      let req: ClientRequest;
      try {
        req = send(url, { method, headers }, res => {
          const status = res.statusCode ?? 0;
          const chunks: Buffer[] = []; let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) { res.destroy(); finish(new LeadRelayFeedError('unexpected_answer', status)); return; }
            chunks.push(chunk);
          });
          res.on('error', () => finish(new LeadRelayFeedError('unreachable', status)));
          res.on('end', () => {
            if (status === 401 || status === 403) return finish(new LeadRelayFeedError('unauthorised', status));
            if (status === 404) return finish(new LeadRelayFeedError('not_found', status));
            if (status >= 500 || status === 429 || status === 408) return finish(new LeadRelayFeedError('unreachable', status));
            if (status < 200 || status >= 300) return finish(new LeadRelayFeedError('unexpected_answer', status));
            let body: unknown;
            try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return finish(new LeadRelayFeedError('unexpected_answer', status)); }
            finish(null, { status, body });
          });
        });
      } catch { finish(new LeadRelayFeedError('unreachable')); return; }
      const timer = setTimeout(() => { req.destroy(); finish(new LeadRelayFeedError('unreachable')); }, timeoutMs);
      timer.unref?.();
      req.on('error', () => finish(new LeadRelayFeedError('unreachable')));
      req.end();
    });
  }

  return {
    async outbox() {
      const { body } = await call('GET', `/api/outbox?limit=${LEADRELAY_OUTBOX_PAGE}`);
      if (!Array.isArray(body) || body.length > LEADRELAY_OUTBOX_PAGE) throw new LeadRelayFeedError('unexpected_answer');
      // A row without a usable id can be neither interpreted nor acknowledged; it is left where it is.
      return body.map(parseRow).filter((row): row is LeadRelayOutboxRow | LeadRelayUnreadableRow => row !== null);
    },
    async lead(id) {
      if (!isLeadRelayId(id)) throw new LeadRelayFeedError('unexpected_answer');
      try { return parseLead((await call('GET', `/api/leads/${id}`)).body, id); }
      catch (error) { if (error instanceof LeadRelayFeedError && error.kind === 'not_found') return null; throw error; }
    },
    async ack(id) {
      if (!isLeadRelayId(id)) throw new LeadRelayFeedError('unexpected_answer');
      let body: unknown;
      // An event LeadRelay no longer holds is no longer waiting, which is all an acknowledgement asks for.
      try { body = (await call('POST', `/api/outbox/${id}/ack`)).body; }
      catch (error) { if (error instanceof LeadRelayFeedError && error.kind === 'not_found') return; throw error; }
      if (!record(body) || body.ok !== true) throw new LeadRelayFeedError('unexpected_answer');
    },
  };
}
