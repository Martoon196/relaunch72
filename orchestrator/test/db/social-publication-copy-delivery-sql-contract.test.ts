import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../src/db/migrations/0100_social_publication_copy_delivery.sql',
  import.meta.url,
);

test('0100 keeps artwork instructions in review evidence and sends publication copy only', async () => {
  const sql = (await readFile(migrationUrl, 'utf8')).replace(/\r\n?/g, '\n');
  assert.match(sql, /CREATE OR REPLACE FUNCTION app_private\.company_content_social_publication_copy/);
  assert.match(sql, /decoded->>'body'/);
  assert.match(sql, /'artwork_instructions'/);
  assert.match(sql, /digest\(app_private\.company_content_social_publication_copy\(version\.content_body\), ''sha256''\)/);
  assert.match(sql, /selected_version\.publication_copy, p_scheduled_for/);
  assert.match(sql, /position\([\s\S]*'selected_version\.content_body, p_scheduled_for'[\s\S]*\) > 0 THEN/);
  assert.match(sql, /REVOKE ALL ON FUNCTION app_private\.company_content_social_publication_copy\(text\) FROM PUBLIC/);
});
