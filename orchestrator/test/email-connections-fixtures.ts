/**
 * Stand-ins for "Connect email" tests: a fake Postmark API behind a fetch function (so the real client is exercised),
 * an in-memory connection store with the same rules as migration 0155, and a fake DNS resolver. Nothing touches the
 * network. All tokens, secrets and addresses are synthetic.
 */
import type { DnsResolver } from '../src/email-connections/domains.js';
import type {
  BeginOutcome, CheckOutcome, EmailConnectionDns, EmailConnectionForm, EmailConnectionState, EmailConnectionStep, EmailConnectionStore,
  RunLock, StepOutcome, StepValues, StoredConnectionSource, TermsOutcome,
} from '../src/email-connections/store.js';
import { EmailConnectionForbiddenError } from '../src/email-connections/store.js';
import type { EmailConnectionSecretField } from '../src/email-connections/vault.js';

export const ACCOUNT_TOKEN = '11111111-2222-4333-8444-555555555555';
export const PP_WS = 'd975ff66-336a-46c2-b36b-d7095a11af97';
export const OWNER_SESSION = 'owner-session-token-0123456789abcdef';

interface FakeServer { id: number; name: string; token: string; streams: { id: string; type: string; archived: boolean }[];
  webhooks: { id: number; url: string; stream: string; username: string; password: string; status: 'verified' | 'unverified' }[] }
interface FakeDomain { id: number; name: string; returnPath: string; dkimVerified: boolean; returnPathVerified: boolean }
export interface FakeCall { readonly method: string; readonly path: string; readonly header: string; readonly token: string; readonly body: unknown }

/**
 * A Postmark account. failOn(predicate, status, code) makes the next matching call fail ONCE (after doing nothing),
 * or, with after=true, fail AFTER the work is done (the answer is lost on the way back, as with a timeout).
 */
export class FakePostmark {
  readonly servers: FakeServer[] = [];
  readonly domains: FakeDomain[] = [];
  readonly calls: FakeCall[] = [];
  private nextId = 1000;
  private failures: { match: (call: FakeCall) => boolean; status: number; code: number | null; after: boolean }[] = [];
  /** Called when a webhook is created (and by POST /webhooks/{id}/verify); resolve false to make Postmark's verification fail. */
  verify: (hook: { url: string; username: string; password: string; stream: string; serverId: number }) => Promise<boolean> = async () => true;
  /** How the webhook list shows Status: as stored, absent (as in Postmark's own example list), or in capitals. */
  statusField: 'normal' | 'absent' | 'upper' = 'normal';
  /**
   * How a failing POST /webhooks/{id}/verify answers: 422 with ErrorCode 1364 in the body, 422 with 1364 only in the
   * X-PM-ApiErrorCode header, or 200 with Success false (all documented shapes).
   */
  verifyFailsAs: '422' | '422-header' | '200' = '422';
  /** Set to answer POST /webhooks/{id}/verify with exactly this (any shape), after the webhook's status is set to verifiedAs. */
  verifyAnswer: { status: number; body: string; verifiedAs?: 'verified' | 'unverified' } | null = null;
  /** The per-trigger results Postmark reports for a failing verification (Bounce answered 401 here). */
  private results(ok: boolean) {
    return [{ TriggerType: 'Bounce', Success: ok, StatusCode: ok ? 200 : 401, Message: `Remote server returned an HTTP status code of ${ok ? 200 : 401}. https://hook.example/secret-ish` },
      { TriggerType: 'SpamComplaint', Success: true, StatusCode: 200, Message: 'Remote server returned an HTTP status code of 200.' },
      { TriggerType: 'SubscriptionChange', Success: true, StatusCode: 200, Message: 'Remote server returned an HTTP status code of 200.' }];
  }

  failOn(match: (call: FakeCall) => boolean, status = 500, code: number | null = null, after = false): void { this.failures.push({ match, status, code, after }); }
  /** The error code only in the X-PM-ApiErrorCode header, with an empty body. */
  headerCode: number | null = null;
  count(method: string, path: RegExp): number { return this.calls.filter(call => call.method === method && path.test(call.path)).length; }

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (url.origin !== 'https://api.postmarkapp.com') throw new TypeError('unexpected host');
    if (init?.redirect !== 'error') throw new Error('redirects must be refused');
    const headers = init?.headers as Record<string, string>;
    const header = headers['X-Postmark-Account-Token'] ? 'account' : headers['X-Postmark-Server-Token'] ? 'server' : 'none';
    const token = headers['X-Postmark-Account-Token'] ?? headers['X-Postmark-Server-Token'] ?? '';
    const body = typeof init?.body === 'string' && init.body ? JSON.parse(init.body) : null;
    const call: FakeCall = { method: init?.method ?? 'GET', path: url.pathname + url.search, header, token, body };
    this.calls.push(call);
    const failure = this.failures.find(item => item.match(call));
    if (failure) this.failures.splice(this.failures.indexOf(failure), 1);
    if (failure && !failure.after && this.headerCode !== null) return new Response('', { status: failure.status, headers: { 'x-pm-apierrorcode': String(this.headerCode) } });
    if (failure && !failure.after) return this.json(failure.status, failure.code === null ? { Message: 'Fake failure' } : { ErrorCode: failure.code, Message: `secret-ish text ${token}` });
    const answer = await this.route(call, url);
    if (failure) return this.json(failure.status, failure.code === null ? { Message: 'Fake failure' } : { ErrorCode: failure.code, Message: 'lost' });
    return answer;
  }) as typeof fetch;

  private json(status: number, body: unknown): Response { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }); }
  private serverOf(token: string): FakeServer | undefined { return this.servers.find(server => server.token === token); }
  private domainBody(domain: FakeDomain) {
    return { ID: domain.id, Name: domain.name, DKIMVerified: domain.dkimVerified, DKIMHost: domain.dkimVerified ? `${domain.id}pm._domainkey.${domain.name}` : '',
      DKIMTextValue: domain.dkimVerified ? `k=rsa; p=KEY${domain.id}` : '', DKIMPendingHost: domain.dkimVerified ? '' : `${domain.id}pm._domainkey.${domain.name}`,
      DKIMPendingTextValue: domain.dkimVerified ? '' : `k=rsa; p=KEY${domain.id}`, DKIMUpdateStatus: domain.dkimVerified ? 'Verified' : 'Pending',
      ReturnPathDomain: domain.returnPath, ReturnPathDomainCNAMEValue: 'pm.mtasv.net', ReturnPathDomainVerified: domain.returnPathVerified };
  }

  private async route(call: FakeCall, url: URL): Promise<Response> {
    const { method } = call, path = url.pathname, body = call.body as Record<string, any> | null;
    if (call.header === 'account') {
      if (call.token !== ACCOUNT_TOKEN) return this.json(401, { ErrorCode: 10, Message: 'bad token' });
      if (method === 'GET' && path === '/servers') {
        const name = url.searchParams.get('name') ?? '';
        const list = this.servers.filter(server => server.name.includes(name));
        return this.json(200, { TotalCount: list.length, Servers: list.map(server => ({ ID: server.id, Name: server.name, ApiTokens: [server.token] })) });
      }
      let m = /^\/servers\/(\d+)$/u.exec(path);
      if (method === 'GET' && m) {
        const server = this.servers.find(item => item.id === Number(m![1]));
        return server ? this.json(200, { ID: server.id, Name: server.name, ApiTokens: [server.token] }) : this.json(404, { ErrorCode: 0, Message: 'no' });
      }
      if (method === 'POST' && path === '/servers') {
        if (this.servers.some(server => server.name === body!.Name)) return this.json(422, { ErrorCode: 603, Message: 'exists' });
        if (body!.DeliveryType !== 'Live') return this.json(422, { ErrorCode: 613, Message: 'type' });
        const server: FakeServer = { id: this.nextId++, name: body!.Name, token: `srv-${this.nextId}-0123456789abcdef0123`, streams: [
          { id: 'outbound', type: 'Transactional', archived: false }], webhooks: [] };
        this.servers.push(server);
        return this.json(200, { ID: server.id, Name: server.name, ApiTokens: [server.token], ServerLink: `https://postmarkapp.com/servers/${server.id}/streams` });
      }
      if (method === 'GET' && path === '/domains') {
        return this.json(200, { TotalCount: this.domains.length, Domains: this.domains.map(domain => ({ ID: domain.id, Name: domain.name })) });
      }
      if (method === 'POST' && path === '/domains') {
        if (['gmail.com'].includes(body!.Name)) return this.json(422, { ErrorCode: 503, Message: 'public' });
        if (this.domains.some(domain => domain.name === body!.Name)) return this.json(422, { ErrorCode: 512, Message: 'exists' });
        const domain: FakeDomain = { id: this.nextId++, name: body!.Name, returnPath: body!.ReturnPathDomain, dkimVerified: false, returnPathVerified: false };
        this.domains.push(domain);
        return this.json(200, this.domainBody(domain));
      }
      m = /^\/domains\/(\d+)(?:\/(verifyDkim|verifyReturnPath))?$/u.exec(path);
      if (m) {
        const domain = this.domains.find(item => item.id === Number(m![1]));
        if (!domain) return this.json(422, { ErrorCode: 510, Message: 'no' });
        if ((method === 'GET' && !m[2]) || (method === 'PUT' && m[2])) return this.json(200, this.domainBody(domain));
        if (method === 'DELETE' && !m[2]) { this.domains.splice(this.domains.indexOf(domain), 1); return this.json(200, { ErrorCode: 0, Message: `Domain ${domain.name} removed.` }); }
      }
      return this.json(404, { ErrorCode: 0, Message: 'unknown' });
    }
    const server = this.serverOf(call.token);
    if (!server) return this.json(401, { ErrorCode: 10, Message: 'bad token' });
    if (method === 'GET' && path === '/message-streams') {
      const archived = url.searchParams.get('IncludeArchivedStreams') === 'true';
      return this.json(200, { MessageStreams: server.streams.filter(s => s.type === 'Broadcasts' && (archived || !s.archived))
        .map(s => ({ ID: s.id, ServerID: server.id, MessageStreamType: s.type, ArchivedAt: s.archived ? '2026-01-01T00:00:00Z' : null })), TotalCount: 0 });
    }
    if (method === 'POST' && path === '/message-streams') {
      if (server.streams.some(s => s.id === body!.ID)) return this.json(422, { ErrorCode: 1230, Message: 'exists' });
      server.streams.push({ id: body!.ID, type: body!.MessageStreamType, archived: false });
      return this.json(200, { ID: body!.ID, ServerID: server.id, Name: body!.Name, MessageStreamType: body!.MessageStreamType });
    }
    if (method === 'GET' && path === '/webhooks') {
      const stream = url.searchParams.get('MessageStream');
      if (!server.streams.some(s => s.id === stream)) return this.json(422, { ErrorCode: 1226, Message: 'no stream' });
      return this.json(200, { Webhooks: server.webhooks.filter(hook => hook.stream === stream).map(hook => ({ ID: hook.id, Url: hook.url, MessageStream: hook.stream,
        HttpAuth: { Username: hook.username, Password: hook.password }, ...(this.statusField === 'absent' ? {} : { Status: this.statusField === 'upper' ? hook.status.toUpperCase() : hook.status }),
        Triggers: {} })) });
    }
    if (method === 'POST' && path === '/webhooks') {
      const hook = { id: this.nextId++, url: body!.Url, stream: body!.MessageStream, username: body!.HttpAuth.Username, password: body!.HttpAuth.Password, status: 'verified' as const };
      if (!(await this.verify({ ...hook, serverId: server.id }))) return this.json(422, { Id: hook.id, Url: hook.url, Success: false, Results: this.results(false), ErrorCode: 1364, Message: '2/3 triggers verified successfully' });
      server.webhooks.push(hook);
      return this.json(200, { ID: hook.id, Url: hook.url, MessageStream: hook.stream, HttpAuth: { Username: hook.username, Password: hook.password } });
    }
    const v = /^\/webhooks\/(\d+)\/verify$/u.exec(path);
    if (method === 'POST' && v) {
      const hook = server.webhooks.find(item => item.id === Number(v[1]));
      if (!hook) return this.json(422, { ErrorCode: 1352, Message: 'no' });
      if (this.verifyAnswer) {
        if (this.verifyAnswer.verifiedAs) hook.status = this.verifyAnswer.verifiedAs;
        return new Response(this.verifyAnswer.body === '' ? null : this.verifyAnswer.body, { status: this.verifyAnswer.status, headers: { 'content-type': 'application/json' } });
      }
      const ok = await this.verify({ ...hook, serverId: server.id });
      hook.status = ok ? 'verified' : 'unverified';
      if (!ok && this.verifyFailsAs === '422-header') {
        return new Response(JSON.stringify({ Id: hook.id, Url: hook.url, Success: false, Results: this.results(false), Message: '2/3 triggers verified successfully' }),
          { status: 422, headers: { 'content-type': 'application/json', 'x-pm-apierrorcode': '1364' } });
      }
      if (!ok && this.verifyFailsAs === '422') return this.json(422, { Id: hook.id, Url: hook.url, Success: false, Results: this.results(false), ErrorCode: 1364, Message: '2/3 triggers verified successfully' });
      return this.json(200, { Id: hook.id, Url: hook.url, Success: ok, Results: this.results(ok), Message: ok ? '3/3 triggers verified successfully' : '2/3 triggers verified successfully' });
    }
    const m = /^\/webhooks\/(\d+)$/u.exec(path);
    if (method === 'DELETE' && m) {
      const index = server.webhooks.findIndex(hook => hook.id === Number(m[1]));
      if (index < 0) return this.json(422, { ErrorCode: 1352, Message: 'no' });
      server.webhooks.splice(index, 1);
      return this.json(200, { ErrorCode: 0, Message: 'deleted' });
    }
    return this.json(404, { ErrorCode: 0, Message: 'unknown' });
  }
}

type Row = { -readonly [K in keyof EmailConnectionState]: EmailConnectionState[K] } & { sealedServerToken: string | null; sealedWebhookSecret: string | null; termsBy: string | null };

/** The rules of migration 0155, in memory. Only OWNER_SESSION (or extra sessions given) on PP_WS is an eligible owner. */
export class MemoryEmailConnectionStore implements EmailConnectionStore {
  row: Row | null = null;
  readonly events: { step: string; outcome: string; domain: string | null }[] = [];
  private held = false;
  private waiters: (() => void)[] = [];
  /** Throws this once from the named method (to inject a database failure). */
  failNext: { method: string; error: Error } | null = null;
  constructor(readonly owners: ReadonlySet<string> = new Set([OWNER_SESSION]), readonly names: Readonly<Record<string, string>> = { [OWNER_SESSION]: 'Pat Owner' }) {}

  private auth(session: string, workspace: string, method: string): void {
    if (this.failNext?.method === method) { const error = this.failNext.error; this.failNext = null; throw error; }
    if (!this.owners.has(session) || workspace !== PP_WS) throw new EmailConnectionForbiddenError();
  }
  private live(): Row {
    if (!this.row || !['creating', 'needs_attention'].includes(this.row.status)) throw Object.assign(new Error('not being set up'), { code: '55000' });
    return this.row;
  }
  private bump(row: Row): void { row.rowVersion += 1; }
  private event(step: string, outcome: string): void { this.events.push({ step, outcome, domain: this.row?.domain ?? null }); }

  async state(session: string, workspace: string): Promise<EmailConnectionState> {
    this.auth(session, workspace, 'state');
    if (!this.row) return Object.freeze({ status: 'not_connected', step: null, domain: null, fromName: null, fromAddress: null, replyTo: null, serverId: null, domainId: null,
      stream: null, webhookId: null, hasServerToken: false, hasWebhookSecret: false, mode: 'off', dns: null, verifiedAt: null, rowVersion: 0,
      protection: { state: 'ok' as const, reason: null, since: null, dailyCap: 50, hourlyCap: 13, warmupStartedAt: null }, terms: null, goLiveApprovedAt: null, domainAttempted: false });
    const { sealedServerToken, sealedWebhookSecret, termsBy: _by, ...rest } = this.row;
    const domain = this.row.domain, events = this.events;
    const domainAttempted = events.some((e, i) => e.step === 'domain' && e.outcome === 'started' && e.domain === domain
      && !events.slice(i).some(t => t.step === 'domain' && t.outcome === 'domain_taken' && t.domain === domain));
    return Object.freeze({ ...rest, hasServerToken: sealedServerToken !== null, hasWebhookSecret: sealedWebhookSecret !== null, domainAttempted });
  }
  async acceptTerms(session: string, workspace: string, version: string): Promise<TermsOutcome> {
    this.auth(session, workspace, 'acceptTerms');
    if (this.row?.terms?.version === version) return 'already';
    const terms = { version, acceptedAt: new Date().toISOString(), acceptedByName: this.names[session] ?? null };
    if (!this.row) {
      this.row = { status: 'not_connected', step: null, domain: null, fromName: null, fromAddress: null, replyTo: null, serverId: null, domainId: null, stream: null,
        webhookId: null, hasServerToken: false, hasWebhookSecret: false, mode: 'off', dns: null, verifiedAt: null, rowVersion: 1,
        protection: { state: 'ok' as const, reason: null, since: null, dailyCap: 50, hourlyCap: 13, warmupStartedAt: null }, terms, goLiveApprovedAt: null, domainAttempted: false,
        sealedServerToken: null, sealedWebhookSecret: null, termsBy: session };
    } else { this.row.terms = terms; this.row.termsBy = session; this.bump(this.row); }
    this.event('terms', 'accepted');
    return 'accepted';
  }
  async begin(session: string, workspace: string, form: EmailConnectionForm, terms: string): Promise<BeginOutcome> {
    this.auth(session, workspace, 'begin');
    const row = this.row;
    if (!row || row.terms?.version !== terms) return 'terms_required';
    if (row.status === 'dns_pending' || row.status === 'verified') { this.event('begin', 'already_connected'); return 'already_connected'; }
    const same = row.domain === form.domain;
    Object.assign(row, { status: 'creating', step: null, domain: form.domain, fromName: form.fromName, fromAddress: form.fromAddress, replyTo: form.replyTo,
      domainId: same ? row.domainId : null, dns: same ? row.dns : null, verifiedAt: null });
    this.bump(row); this.event('begin', 'started');
    return 'started';
  }
  async intend(session: string, workspace: string, step: EmailConnectionStep): Promise<void> {
    this.auth(session, workspace, 'intend');
    const row = this.live(); row.status = 'creating'; row.step = step; this.bump(row); this.event(step, 'started');
  }
  async record(session: string, workspace: string, step: EmailConnectionStep, outcome: StepOutcome, values: StepValues = {}): Promise<void> {
    this.auth(session, workspace, 'record');
    const row = this.live();
    if (outcome !== 'created' && outcome !== 'adopted') row.status = 'needs_attention';
    else if (step === 'server') row.serverId = values.serverId!;
    else if (step === 'stream') row.stream = values.stream!;
    else if (step === 'webhook') row.webhookId = values.webhookId!;
    else if (step === 'domain') { row.domainId = values.domainId!; row.dns = values.dns!; row.status = 'dns_pending'; row.step = null; }
    this.bump(row); this.event(step, outcome);
  }
  async saveSealed(session: string, workspace: string, field: EmailConnectionSecretField, sealed: string): Promise<void> {
    this.auth(session, workspace, 'saveSealed');
    const row = this.live();
    if (field === 'server_token') row.sealedServerToken = sealed; else row.sealedWebhookSecret = sealed;
    this.bump(row); this.event(field === 'server_token' ? 'server' : 'secret', field === 'server_token' ? 'token_saved' : 'saved');
  }
  async sealed(session: string, workspace: string) {
    this.auth(session, workspace, 'sealed');
    return { serverToken: this.row?.sealedServerToken ?? null, webhookSecret: this.row?.sealedWebhookSecret ?? null };
  }
  async checked(session: string, workspace: string, dns: EmailConnectionDns, dkim: boolean, returnPath: boolean): Promise<CheckOutcome> {
    this.auth(session, workspace, 'checked');
    const row = this.row!;
    if (!['dns_pending', 'verified'].includes(row.status)) throw Object.assign(new Error('nothing to check'), { code: '55000' });
    const outcome: CheckOutcome = dkim && returnPath ? 'verified' : dkim || returnPath ? 'partial' : 'pending';
    row.dns = dns; row.status = outcome === 'verified' ? 'verified' : 'dns_pending'; row.verifiedAt = outcome === 'verified' ? (row.verifiedAt ?? new Date().toISOString()) : null;
    this.bump(row); this.event('check', outcome);
    return outcome;
  }
  async disconnect(session: string, workspace: string): Promise<void> {
    this.auth(session, workspace, 'disconnect');
    const row = this.row;
    if (!row || row.status === 'disconnected') return;
    Object.assign(row, { status: 'disconnected', step: null, webhookId: null, sealedServerToken: null, sealedWebhookSecret: null, verifiedAt: null });
    this.bump(row); this.event('disconnect', 'done');
  }
  sourcesFail: Error | null = null;
  absent = false;
  async present(): Promise<boolean> { return !this.absent; }
  async sources(): Promise<readonly StoredConnectionSource[] | null> {
    if (this.sourcesFail) throw this.sourcesFail;
    const row = this.row;
    if (!row || row.status === 'disconnected' || !row.serverId || !row.sealedServerToken || !row.sealedWebhookSecret) return [];
    return [{ workspaceId: PP_WS, serverId: String(row.serverId), stream: row.stream ?? 'broadcast', sealedServerToken: row.sealedServerToken, sealedWebhookSecret: row.sealedWebhookSecret }];
  }
  /** Set true to make the next held lock report itself lost after this many lost() calls. */
  loseLockAfter: number | null = null;
  otherHolds: boolean | 'unknown' = false;
  async otherConnectionHolds(): Promise<boolean> { if (this.otherHolds === 'unknown') throw new Error('cannot tell'); return this.otherHolds; }
  async lock(_workspace: string, waitMs: number): Promise<RunLock | null> {
    if (this.held) {
      const got = await new Promise<boolean>(resolve => {
        const timer = setTimeout(() => { this.waiters.splice(this.waiters.indexOf(wake), 1); resolve(false); }, waitMs);
        const wake = () => { clearTimeout(timer); resolve(true); };
        this.waiters.push(wake);
      });
      if (!got) return null;
    }
    this.held = true;
    let calls = 0, released = false;
    const loseAfter = this.loseLockAfter; this.loseLockAfter = null;
    return {
      lost: () => loseAfter !== null && ++calls > loseAfter,
      release: async () => { if (released) return; released = true; const next = this.waiters.shift(); if (next) next(); else this.held = false; },
    };
  }
}

/** DNS answers by host. Absent host: ENOTFOUND. */
export function fakeResolver(input: { txt?: Record<string, string[][]>; cname?: Record<string, string[]>; ns?: Record<string, string[]> } = {}): DnsResolver {
  const missing = () => Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
  return {
    async resolveTxt(host) { const v = input.txt?.[host]; if (!v) throw missing(); return v; },
    async resolveCname(host) { const v = input.cname?.[host]; if (!v) throw missing(); return v; },
    async resolveNs(host) { const v = input.ns?.[host]; if (!v) throw missing(); return v; },
  };
}
