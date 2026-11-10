/**
 * Operator OAuth migration identity. Additive: three private tables and definer
 * functions. If another branch lands first, rename the .sql file, update the
 * filename here, re-pin the checksum and re-run the migration contract and
 * readiness tests.
 */
export const OPERATOR_OAUTH_MIGRATION = '0148_operator_oauth_tokens.sql';
export const OPERATOR_OAUTH_CHECKSUM = '74f849d2fb65391caef94769cec4509839155a99c838966c3c66e3f9c3bb8c68';
