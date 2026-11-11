/**
 * Module kits migration identity (MHP-KITS-001). Additive: two private tables, definer functions, and one OR
 * clause added to each of four released MHP functions. If another branch lands first, rename the .sql file,
 * update the filename here, re-pin the checksum and re-run the migration contract and readiness tests.
 */
export const MHP_KITS_MIGRATION = '0149_mhp_kits.sql';
export const MHP_KITS_CHECKSUM = 'bc847eb6e294c629e5f4a423e135261abdee1b25bbc2bab7502d6955294054fb';
