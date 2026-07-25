/**
 * CRM store — the swappable persistence seam. `MemoryCrmStore` holds everything
 * in memory (£0, deterministic, for tests + demos); `JsonCrmStore` persists the
 * same state to a JSON file. A real database adapter later implements the same
 * `CrmStore` interface with no change to callers — the same mock/live pattern as
 * every other rail.
 */

import fs from 'node:fs';
import { PIPELINE_STAGES, type Activity, type Contact, type PipelineStage, type Tenant, type TenantView } from './types.js';

export interface NewContact {
  name: string;
  email?: string;
  phone?: string;
  stage?: PipelineStage;
}

export interface CrmStore {
  upsertTenant(t: { id: string; name: string; runDir?: string }): Promise<Tenant>;
  getTenant(id: string): Promise<Tenant | null>;
  listTenants(): Promise<Tenant[]>;
  addContact(tenantId: string, c: NewContact): Promise<Contact>;
  moveContact(contactId: string, stage: PipelineStage): Promise<Contact>;
  addActivity(a: Omit<Activity, 'id'>): Promise<Activity>;
  tenantView(tenantId: string): Promise<TenantView>;
}

interface State {
  tenants: Tenant[];
  contacts: Contact[];
  activities: Activity[];
  contactSeq: number;
  activitySeq: number;
}

function emptyState(): State {
  return { tenants: [], contacts: [], activities: [], contactSeq: 0, activitySeq: 0 };
}

function emptyPipeline(): Record<PipelineStage, number> {
  return Object.fromEntries(PIPELINE_STAGES.map((s) => [s, 0])) as Record<PipelineStage, number>;
}

export class MemoryCrmStore implements CrmStore {
  protected state: State = emptyState();

  /** Overridden by persisting stores; a no-op in memory. */
  protected persist(): void {}

  async upsertTenant(t: { id: string; name: string; runDir?: string }): Promise<Tenant> {
    const existing = this.state.tenants.find((x) => x.id === t.id);
    if (existing) {
      existing.name = t.name;
      if (t.runDir !== undefined) existing.runDir = t.runDir;
      this.persist();
      return existing;
    }
    const tenant: Tenant = { id: t.id, name: t.name, runDir: t.runDir, createdAt: new Date().toISOString() };
    this.state.tenants.push(tenant);
    this.persist();
    return tenant;
  }

  async getTenant(id: string): Promise<Tenant | null> {
    return this.state.tenants.find((t) => t.id === id) ?? null;
  }

  async listTenants(): Promise<Tenant[]> {
    return [...this.state.tenants];
  }

  async addContact(tenantId: string, c: NewContact): Promise<Contact> {
    if (!this.state.tenants.some((t) => t.id === tenantId)) throw new Error(`No such tenant: ${tenantId}`);
    const contact: Contact = {
      id: `c-${++this.state.contactSeq}`,
      tenantId,
      name: c.name,
      email: c.email,
      phone: c.phone,
      stage: c.stage ?? 'lead',
      createdAt: new Date().toISOString(),
    };
    this.state.contacts.push(contact);
    await this.addActivity({ tenantId, at: contact.createdAt, kind: 'contact_created', channel: 'system', summary: `New contact: ${contact.name}`, contactId: contact.id });
    this.persist();
    return contact;
  }

  async moveContact(contactId: string, stage: PipelineStage): Promise<Contact> {
    const contact = this.state.contacts.find((c) => c.id === contactId);
    if (!contact) throw new Error(`No such contact: ${contactId}`);
    const from = contact.stage;
    contact.stage = stage;
    await this.addActivity({ tenantId: contact.tenantId, at: new Date().toISOString(), kind: 'stage_changed', channel: 'system', summary: `${contact.name}: ${from} → ${stage}`, contactId });
    this.persist();
    return contact;
  }

  async addActivity(a: Omit<Activity, 'id'>): Promise<Activity> {
    const activity: Activity = { id: `act-${++this.state.activitySeq}`, ...a };
    this.state.activities.push(activity);
    this.persist();
    return activity;
  }

  async tenantView(tenantId: string): Promise<TenantView> {
    const tenant = await this.getTenant(tenantId);
    if (!tenant) throw new Error(`No such tenant: ${tenantId}`);
    const contacts = this.state.contacts.filter((c) => c.tenantId === tenantId);
    const pipeline = emptyPipeline();
    for (const c of contacts) pipeline[c.stage]++;
    const activity = this.state.activities
      .filter((a) => a.tenantId === tenantId)
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.id.localeCompare(a.id)));
    return { tenant, contacts, pipeline, activity };
  }
}

export class JsonCrmStore extends MemoryCrmStore {
  constructor(private readonly file: string) {
    super();
    if (fs.existsSync(file)) this.state = JSON.parse(fs.readFileSync(file, 'utf8')) as State;
  }

  protected persist(): void {
    fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2), 'utf8');
  }
}
