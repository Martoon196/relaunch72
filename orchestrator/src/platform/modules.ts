import { isPlatformCapability, type PlatformCapability } from './capabilities.js';

export type PlatformModuleId =
  | 'overview'
  | 'actions'
  | 'crm'
  | 'journeys'
  | 'content'
  | 'affiliates'
  | 'social'
  | 'inbox'
  | 'listening'
  | 'webinars'
  | 'automations'
  | 'analytics'
  | 'settings';

export type PlatformModuleGroup = 'work' | 'channels' | 'intelligence' | 'system';
export type PlatformModuleStage = 'available' | 'preview' | 'planned';
export type PlatformModuleState = 'ready' | 'preview' | 'setup_required' | 'planned' | 'unavailable';

export interface PlatformModuleManifest {
  id: PlatformModuleId;
  label: string;
  shortLabel: string;
  description: string;
  icon: 'home' | 'users' | 'sparkles' | 'send' | 'inbox' | 'radar' | 'video' | 'workflow' | 'chart' | 'settings';
  group: PlatformModuleGroup;
  order: number;
  route?: string;
  stage: PlatformModuleStage;
  requiredCapabilities: readonly PlatformCapability[];
  dependsOn?: readonly PlatformModuleId[];
  visible?: boolean;
}

export interface ModuleRuntimeContext {
  capabilities: ReadonlySet<PlatformCapability>;
  disabledModules?: ReadonlySet<PlatformModuleId>;
}

export interface ResolvedPlatformModule extends PlatformModuleManifest {
  state: PlatformModuleState;
  missingCapabilities: readonly PlatformCapability[];
  blockedBy: readonly PlatformModuleId[];
}

export interface PlatformModuleRegistry {
  readonly modules: readonly PlatformModuleManifest[];
  get(id: PlatformModuleId): PlatformModuleManifest;
  resolve(context: ModuleRuntimeContext): readonly ResolvedPlatformModule[];
  navigation(context: ModuleRuntimeContext): readonly ResolvedPlatformModule[];
}

const MODULE_IDS = new Set<PlatformModuleId>(['overview', 'actions', 'crm', 'journeys', 'content', 'affiliates', 'social', 'inbox', 'listening', 'webinars', 'automations', 'analytics', 'settings']);
const MODULE_GROUPS = new Set<PlatformModuleGroup>(['work', 'channels', 'intelligence', 'system']);
const MODULE_STAGES = new Set<PlatformModuleStage>(['available', 'preview', 'planned']);
const MODULE_ICONS = new Set<PlatformModuleManifest['icon']>(['home', 'users', 'sparkles', 'send', 'inbox', 'radar', 'video', 'workflow', 'chart', 'settings']);

function assertManifest(manifest: PlatformModuleManifest): void {
  if (!manifest.id || !manifest.label.trim() || !manifest.description.trim()) {
    throw new Error('module id, label and description are required');
  }
  if (!MODULE_IDS.has(manifest.id)) throw new Error(`unknown module id: ${manifest.id}`);
  if (!manifest.shortLabel.trim()) throw new Error(`module ${manifest.id} shortLabel is required`);
  if (!MODULE_GROUPS.has(manifest.group)) throw new Error(`module ${manifest.id} has an invalid group`);
  if (!MODULE_STAGES.has(manifest.stage)) throw new Error(`module ${manifest.id} has an invalid stage`);
  if (!MODULE_ICONS.has(manifest.icon)) throw new Error(`module ${manifest.id} has an invalid icon`);
  if (!Array.isArray(manifest.requiredCapabilities)
      || manifest.requiredCapabilities.some((capability) => !isPlatformCapability(capability))) {
    throw new Error(`module ${manifest.id} has an invalid required capability`);
  }
  if (manifest.dependsOn !== undefined && !Array.isArray(manifest.dependsOn)) {
    throw new Error(`module ${manifest.id} dependencies must be an array`);
  }
  if (!Number.isInteger(manifest.order) || manifest.order < 0) {
    throw new Error(`module ${manifest.id} must have a non-negative integer order`);
  }
  if (manifest.stage !== 'planned' && !manifest.route) {
    throw new Error(`module ${manifest.id} needs a route unless it is planned`);
  }
  if (manifest.route && !manifest.route.startsWith('/portal')) {
    throw new Error(`module ${manifest.id} route must stay inside /portal`);
  }
}

function assertDependencies(modules: readonly PlatformModuleManifest[], byId: ReadonlyMap<PlatformModuleId, PlatformModuleManifest>): void {
  for (const module of modules) {
    for (const dependency of module.dependsOn ?? []) {
      if (!byId.has(dependency)) throw new Error(`module ${module.id} depends on unknown module ${dependency}`);
      if (dependency === module.id) throw new Error(`module ${module.id} cannot depend on itself`);
    }
  }

  const visiting = new Set<PlatformModuleId>();
  const visited = new Set<PlatformModuleId>();
  const visit = (id: PlatformModuleId): void => {
    if (visiting.has(id)) throw new Error(`module dependency cycle includes ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const module of modules) visit(module.id);
}

function resolveModule(
  module: PlatformModuleManifest,
  context: ModuleRuntimeContext,
  byId: ReadonlyMap<PlatformModuleId, PlatformModuleManifest>,
  resolved: Map<PlatformModuleId, ResolvedPlatformModule>,
): ResolvedPlatformModule {
  const existing = resolved.get(module.id);
  if (existing) return existing;
  const missingCapabilities = module.requiredCapabilities.filter((capability) => !context.capabilities.has(capability));
  const blockedBy = (module.dependsOn ?? []).filter((dependencyId) => {
    const dependency = byId.get(dependencyId)!;
    const dependencyState = resolveModule(dependency, context, byId, resolved).state;
    return dependencyState !== 'ready' && dependencyState !== 'preview';
  });
  const state: PlatformModuleState = context.disabledModules?.has(module.id)
    ? 'unavailable'
    : module.stage === 'planned'
      ? 'planned'
      : missingCapabilities.length || blockedBy.length
          ? 'setup_required'
          : module.stage === 'preview'
            ? 'preview'
            : 'ready';
  const result = Object.freeze({
    ...module,
    missingCapabilities: Object.freeze(missingCapabilities),
    blockedBy: Object.freeze(blockedBy),
    state,
  });
  resolved.set(module.id, result);
  return result;
}

export function createPlatformModuleRegistry(input: readonly PlatformModuleManifest[]): PlatformModuleRegistry {
  const modules = [...input].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  const byId = new Map<PlatformModuleId, PlatformModuleManifest>();
  const routes = new Set<string>();
  for (const source of modules) {
    assertManifest(source);
    if (byId.has(source.id)) throw new Error(`duplicate module id: ${source.id}`);
    if (source.route && routes.has(source.route)) throw new Error(`duplicate module route: ${source.route}`);
    const manifest = Object.freeze({ ...source, requiredCapabilities: Object.freeze([...source.requiredCapabilities]), dependsOn: Object.freeze([...(source.dependsOn ?? [])]) });
    byId.set(manifest.id, manifest);
    if (manifest.route) routes.add(manifest.route);
  }
  assertDependencies(modules, byId);
  const frozenModules = Object.freeze(modules.map((module) => byId.get(module.id)!));

  return Object.freeze({
    modules: frozenModules,
    get(id: PlatformModuleId): PlatformModuleManifest {
      const module = byId.get(id);
      if (!module) throw new Error(`unknown platform module: ${id}`);
      return module;
    },
    resolve(context: ModuleRuntimeContext): readonly ResolvedPlatformModule[] {
      const resolved = new Map<PlatformModuleId, ResolvedPlatformModule>();
      return Object.freeze(frozenModules.map((module) => resolveModule(module, context, byId, resolved)));
    },
    navigation(context: ModuleRuntimeContext): readonly ResolvedPlatformModule[] {
      const resolved = new Map<PlatformModuleId, ResolvedPlatformModule>();
      return Object.freeze(frozenModules
        .filter((module) => module.visible !== false)
        .map((module) => resolveModule(module, context, byId, resolved)));
    },
  });
}

export const CORE_PLATFORM_MODULES: readonly PlatformModuleManifest[] = Object.freeze([
  { id: 'overview', label: 'Overview', shortLabel: 'Home', description: 'Workspace priorities, activity and connected operations.', icon: 'home', group: 'work', order: 10, route: '/portal', stage: 'available', requiredCapabilities: ['workspace.overview.read'] },
  { id: 'actions', label: 'Operator Action Centre', shortLabel: 'Actions', description: 'One evidence-backed queue for urgent work, ownership and safe snoozing.', icon: 'workflow', group: 'work', order: 15, route: '/portal/actions', stage: 'available', requiredCapabilities: ['actions.read'], dependsOn: ['overview'] },
  { id: 'crm', label: 'CRM', shortLabel: 'CRM', description: 'Private contacts, opportunities, tasks and recorded CRM activity.', icon: 'users', group: 'work', order: 20, route: '/portal/crm/contacts', stage: 'available', requiredCapabilities: ['crm.contacts.read', 'crm.pipeline.read', 'crm.tasks.read'], dependsOn: ['overview'] },
  { id: 'journeys', label: 'Live journeys', shortLabel: 'Journeys', description: 'Operational lead lanes beside evidence-led milestones, scores and next moves.', icon: 'workflow', group: 'work', order: 25, route: '/portal/journeys/board', stage: 'available', requiredCapabilities: ['journeys.read'], dependsOn: ['crm'] },
  { id: 'content', label: 'Content control', shortLabel: 'Content', description: 'Immutable on-brand versions, source proof and exact approvals.', icon: 'sparkles', group: 'work', order: 30, route: '/portal/content', stage: 'available', requiredCapabilities: ['content.drafts.read'], dependsOn: ['overview'] },
  { id: 'affiliates', label: 'Affiliate compliance', shortLabel: 'Affiliates', description: 'Legal packs, acceptance, training, channel authority, cases and fail-closed eligibility.', icon: 'users', group: 'work', order: 35, route: '/portal/affiliates/compliance', stage: 'preview', requiredCapabilities: ['affiliates.compliance.read'], dependsOn: ['overview'] },
  { id: 'social', label: 'Social publishing', shortLabel: 'Social', description: 'Plan, approve, schedule and reconcile social posts.', icon: 'send', group: 'channels', order: 40, stage: 'planned', requiredCapabilities: ['social.publish'], dependsOn: ['content'] },
  { id: 'inbox', label: 'Conversion inbox', shortLabel: 'Inbox', description: 'One approval-led queue for email, WhatsApp, SMS and social conversations.', icon: 'inbox', group: 'channels', order: 50, route: '/portal/inbox', stage: 'preview', requiredCapabilities: ['conversations.read'], dependsOn: ['crm'] },
  { id: 'listening', label: 'Social listening', shortLabel: 'Listening', description: 'Mentions, topics, sentiment and response opportunities.', icon: 'radar', group: 'intelligence', order: 60, stage: 'planned', requiredCapabilities: ['social.listen'], dependsOn: ['social'] },
  { id: 'webinars', label: 'Webinars', shortLabel: 'Webinars', description: 'Events, registrations, attendance and follow-up journeys.', icon: 'video', group: 'channels', order: 70, stage: 'planned', requiredCapabilities: ['webinars.manage'], dependsOn: ['crm'] },
  { id: 'automations', label: 'Automations', shortLabel: 'Automate', description: 'Guardrailed recipes connecting CRM, channels and tasks.', icon: 'workflow', group: 'work', order: 80, stage: 'planned', requiredCapabilities: ['automations.manage'], dependsOn: ['crm'] },
  { id: 'analytics', label: 'Analytics', shortLabel: 'Reports', description: 'Source-labelled performance and operational reporting.', icon: 'chart', group: 'intelligence', order: 90, route: '/portal#analytics', stage: 'preview', requiredCapabilities: ['analytics.read'], dependsOn: ['overview'] },
  { id: 'settings', label: 'Workspace settings', shortLabel: 'Settings', description: 'Billing, people, connections and workspace controls.', icon: 'settings', group: 'system', order: 100, route: '/portal/billing', stage: 'available', requiredCapabilities: ['billing.read'], dependsOn: ['overview'] },
]);

export const platformModules = createPlatformModuleRegistry(CORE_PLATFORM_MODULES);
