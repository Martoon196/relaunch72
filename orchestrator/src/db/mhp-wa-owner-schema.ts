/**
 * MHP owner one-to-one WhatsApp migration identity (MHP-WA-121-001). Additive on 0053/0141/0143: five
 * private tables, a third 0053 authority kind ('mhp_owner_direct'), owner command, worker and webhook
 * definers and two outcome triggers. It grants the WhatsApp worker and webhook roles new functions, so
 * every WhatsApp worker and webhook must run a build that knows them BEFORE it is applied (their exact
 * role-boundary check fails otherwise), and they roll forward only afterwards. If another branch lands first, rename the .sql file, update the
 * filename here, re-pin the checksum and re-run the migration contract and readiness tests.
 */
export const MHP_WA_OWNER_MIGRATION = '0151_mhp_whatsapp_owner_one_to_one.sql';
export const MHP_WA_OWNER_CHECKSUM = '774b8c2a47152b62cb13c3c87ee231c6d0f6af9040e71355b68e89e959ef242e';
