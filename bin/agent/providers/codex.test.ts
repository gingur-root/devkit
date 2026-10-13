// The Codex SDK can't ignore the user config or check the login, so this guard
// is what keeps stray config and API-key logins out of a run.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { assertCodexHome } from './codex.ts';

test('a Codex home with config or a non-ChatGPT login stops the run', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'devkit-agent-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const login = (body: string) => writeFileSync(join(home, 'auth.json'), body);

  login('{"tokens": SECRET');
  assert.throws(
    () => assertCodexHome(home),
    (error: Error) => !error.message.includes('SECRET'),
  );
  login(JSON.stringify({ auth_mode: 'apikey' }));
  assert.throws(() => assertCodexHome(home));
  login(JSON.stringify({ auth_mode: 'chatgpt' }));
  assert.doesNotThrow(() => assertCodexHome(home));
  writeFileSync(join(home, 'config.toml'), '');
  assert.throws(() => assertCodexHome(home));
});
