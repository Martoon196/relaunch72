/**
 * PP follow-up email sequences migration identity (PP-FOLLOWUP-001). Additive on 0127-0151: four private tables
 * pinned to the Property Predator workspace, the NOLOGIN r72_pp_followup_definer and its definer functions. No MHP
 * object is altered and no trigger is added to a shared table. If another branch lands first, rename the .sql file,
 * update the filename here, re-pin the checksum and re-run the migration contract and readiness tests.
 */
export const PP_FOLLOWUP_MIGRATION = '0152_pp_followup_email_sequences.sql';
export const PP_FOLLOWUP_CHECKSUM = '81163cda55091c16fcfdf0caa9669f495411c27b3cfd5da7bb77fe40b97ff92b';
