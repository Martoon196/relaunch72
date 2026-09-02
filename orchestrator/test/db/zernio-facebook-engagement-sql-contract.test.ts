import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0093_property_predator_zernio_facebook_engagement.sql',
  import.meta.url,
);

function normalise(sql: string): string {
  return sql.replace(/--[^\n]*/gu, ' ').replace(/\s+/gu, ' ').trim();
}

test('0093 extends the immutable reply ledger to exact Facebook, Instagram and LinkedIn targets', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  assert.match(sql, /DROP CONSTRAINT property_predator_zernio_reply_drafts_network_check/iu);
  assert.match(sql, /ADD CONSTRAINT property_predator_zernio_reply_drafts_network_check CHECK \(network IN \('facebook', 'instagram', 'linkedin'\)\) NOT VALID/iu);
  assert.match(sql, /VALIDATE CONSTRAINT property_predator_zernio_reply_drafts_network_check/iu);
});

test('0093 replaces every network-qualified reply gate with the three supported engagement networks', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  assert.match(sql, /CREATE OR REPLACE FUNCTION app_private\.zernio_reply_channel_truth\(/iu);
  assert.match(sql, /CREATE OR REPLACE FUNCTION app_private\.create_zernio_reply_draft\(/iu);
  assert.match(sql, /CREATE OR REPLACE FUNCTION app_private\.claim_zernio_reply_send\(/iu);
  assert.equal((sql.match(/p_network (?:NOT )?IN \('facebook', 'instagram', 'linkedin'\)/giu) ?? []).length, 3);
  assert.doesNotMatch(sql, /p_network (?:NOT )?IN \('instagram', 'linkedin'\)/iu);
});

test('0093 retains founder membership, exact account truth and durable pause checks', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  assert.match(sql, /membership\.status = 'active' AND membership\.role IN \('owner', 'admin'\)/iu);
  assert.match(sql, /account\.network = p_network AND account\.environment = 'live' AND account\.status = 'active'/iu);
  assert.match(sql, /pause\.scope IN \('all', 'social_dm'\)/iu);
  assert.match(sql, /selected_decision\.decision <> 'approved'/iu);
});

test('0093 leaves only the network-qualified login surfaces executable', async () => {
  const sql = normalise(await readFile(migrationUrl, 'utf8'));
  assert.match(sql, /REVOKE ALL ON FUNCTION app_private\.create_zernio_reply_draft\( uuid, uuid, uuid, text, bytea, bytea, bytea, text, bytea \) FROM PUBLIC/iu);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.claim_zernio_reply_send\( uuid, uuid, uuid, uuid, text, bytea, bytea, bytea, bytea, bytea \) TO r72_zernio_social_command/iu);
  assert.match(sql, /REVOKE EXECUTE ON FUNCTION app_private\.create_zernio_reply_draft\( uuid, uuid, uuid, bytea, bytea, bytea, text, bytea \) FROM r72_zernio_social_command/iu);
  assert.match(sql, /Unexpected Zernio reply function grantee/iu);
});
