import type { SqlMigration } from './migrate.js';

export const MHP_WHATSAPP_MIGRATION = '0141_mhp_event_whatsapp_programme.sql';
export const MHP_WHATSAPP_MIGRATION_SHA = 'f2a7617a925f39d41ac3a606de9f9dd864b52a2725d8ed7c89d37737c4fe747c';
const TAIL = '0140_private_method_automatic_defaults.sql';
const TAIL_SHA = 'a4b53f5721855e300cd49665cc5faa773f3c80240fbcca3fe3f31379c7f3a378';
/** A deliberate recovery artifact: remove only the exact additive141 from a140 source ledger comparison. */
export function mhpWhatsAppSchemaBridgeAllowed(migrations: readonly SqlMigration[], applied: ReadonlyMap<string, string>): boolean {
  return migrations.length === 140 && migrations[139]?.filename === TAIL && migrations[139]?.checksum === TAIL_SHA
    && applied.get(TAIL) === TAIL_SHA && applied.get(MHP_WHATSAPP_MIGRATION) === MHP_WHATSAPP_MIGRATION_SHA;
}
/** New grants are admitted only after this exact migration; no event service is composed by this bridge. */
export function mhpWhatsAppBridgeBoundaryExtras(kind: 'command' | 'worker' | 'webhook', applied: ReadonlyMap<string, string>): readonly string[] {
  if (applied.get(TAIL) !== TAIL_SHA || applied.get(MHP_WHATSAPP_MIGRATION) !== MHP_WHATSAPP_MIGRATION_SHA) return [];
  const extra = {
  "command": [
    "app_private.mhp_whatsapp_connect(bytea,uuid,uuid,uuid,text,text,text,text,text,bytea,bytea,bytea,bytea,bytea,text,boolean)",
    "app_private.mhp_event_whatsapp_review(bytea,uuid)",
    "app_private.mhp_event_whatsapp_activate(bytea,uuid,uuid,bytea,uuid[],jsonb,bytea,text,boolean,boolean)",
    "app_private.mhp_event_whatsapp_control(bytea,uuid,text,uuid,bytea,text)"
  ],
  "worker": [
    "app_private.record_mhp_whatsapp_template_observation(uuid,uuid,text,text,text,text,text,integer,bytea,bytea,bytea)",
    "app_private.mhp_event_whatsapp_observation_targets(uuid,uuid)",
    "app_private.mhp_prepare_event_whatsapp(uuid,uuid,integer)",
    "app_private.claim_event_whatsapp_job(uuid,uuid,bytea,integer)",
    "app_private.load_event_whatsapp_job(uuid,uuid,bigint,bytea)",
    "app_private.begin_event_whatsapp_call(uuid,uuid,bigint,bytea,boolean,boolean)",
    "app_private.mhp_hold_event_whatsapp()"
  ],
  "webhook": [
    "app_private.mhp_record_event_whatsapp_inbound(uuid,uuid,text,text,text,text,bytea,bytea,bytea,bytea,bytea,timestamp with time zone)"
  ]
} as const;
  return extra[kind];
}
