import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migration = new URL(
  '../../src/db/migrations/0098_zernio_messaging_provider_account_binding.sql',
  import.meta.url,
);

test('social account read exposes only the provider digest needed for messaging binding', async () => {
  const sql = await readFile(migration, 'utf8');
  assert.match(sql, /account_id uuid, provider_account_id_sha256 bytea/u);
  assert.match(sql, /SELECT account\.id, account\.provider_account_id_sha256/u);
  assert.doesNotMatch(sql, /provider_account_id[^_]/u);
  assert.match(sql, /REVOKE ALL ON FUNCTION app_private\.read_zernio_social_accounts/u);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION app_private\.read_zernio_social_accounts/u);
});
