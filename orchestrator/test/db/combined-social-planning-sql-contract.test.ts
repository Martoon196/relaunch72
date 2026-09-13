import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('0104 validates combined images separately without relaxing legacy text or role boundaries', async () => {
  const sql = (await readFile(new URL('../../src/db/migrations/0104_combined_social_planning_validation.sql', import.meta.url), 'utf8'))
    .replace(/--[^\n]*/g, '').replace(/\s+/g, ' ');
  assert.match(sql, /CREATE OR REPLACE FUNCTION app_private.public_social_body_supported/);
  assert.match(sql, /SECURITY DEFINER SET search_path = pg_catalog/);
  assert.match(sql, /octet_length\(p_body\) NOT BETWEEN 1 AND 900000/);
  assert.match(sql, /NOT app_private.public_social_display_text_supported\(p_body\)/);
  assert.match(sql, /company_content_social_image\(p_body\) IS NULL/);
  assert.match(sql, /octet_length\(publication_copy\) NOT BETWEEN 1 AND 16384/);
  assert.match(sql, /checked_text := \(decoded - 'image'\)::text/);
  assert.match(sql, /octet_length\(checked_text\) BETWEEN 1 AND 16384/);
  assert.equal((sql.match(/GRANT EXECUTE/g) ?? []).length, 2);
  assert.equal((sql.match(/TO r72_public_social_definer/g) ?? []).length, 2);
  assert.doesNotMatch(sql, /ALTER ROLE|ALTER POLICY|UPDATE app\.|DELETE FROM|TO PUBLIC|TO r72_web|TO r72_.*_command/);
});
