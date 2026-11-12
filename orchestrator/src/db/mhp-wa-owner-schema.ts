/**
 * MHP owner one-to-one WhatsApp migration identity (MHP-WA-121-001). Additive on 0053/0141/0143: five
 * private tables, a third 0053 authority kind ('mhp_owner_direct'), owner command, worker and webhook
 * definers and two outcome triggers. If another branch lands first, rename the .sql file, update the
 * filename here, re-pin the checksum and re-run the migration contract and readiness tests.
 */
export const MHP_WA_OWNER_MIGRATION = '0151_mhp_whatsapp_owner_one_to_one.sql';
export const MHP_WA_OWNER_CHECKSUM = '34a33e6286b9c3a55130e794267da593be798c271a169ffc7076315d96c6d708';
