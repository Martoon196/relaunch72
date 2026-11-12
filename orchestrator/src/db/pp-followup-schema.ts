/**
 * PP follow-up email sequences migration identity (PP-FOLLOWUP-001). Additive on 0127-0151: four private tables
 * pinned to the Property Predator workspace, the NOLOGIN r72_pp_followup_definer and its definer functions. No MHP
 * object is altered and no trigger is added to a shared table. If another branch lands first, rename the .sql file,
 * update the filename here, re-pin the checksum and re-run the migration contract and readiness tests.
 */
export const PP_FOLLOWUP_MIGRATION = '0152_pp_followup_email_sequences.sql';
export const PP_FOLLOWUP_CHECKSUM = '5769a2cb9b3b8a25df8605c9046ea6f15bc13431a47111a9ccf2428ccf354fd5';
