// The Codex SDK can't ignore the user config, so these guards are all that
// keeps account apps, plugins and API-key logins out of a run.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { assertCodexHome, codexOptions } from './codex.ts';

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'devkit-agent-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('Codex turns off account apps, plugins, subagents and bundled skills', () => {
  const { config } = codexOptions({ executable: '/bin/codex', env: {} });
  assert.deepEqual(config, {
    features: {
      apps: false,
      plugins: false,
      remote_plugin: false,
      hooks: false,
      memories: false,
      multi_agent: false,
      goals: false,
      image_generation: false,
    },
    agents: { enabled: false },
    skills: { bundled: { enabled: false } },
  });
});

test('a Codex home with config or a non-ChatGPT login stops the run', () => {
  const home = scratch();
  assert.throws(() => assertCodexHome(home), /No Codex login/);
  writeFileSync(join(home, 'auth.json'), '{"tokens": SECRETVALUE');
  assert.throws(
    () => assertCodexHome(home),
    (error: Error) => /not readable JSON/.test(error.message) && !error.message.includes('SECRET'),
  );
  writeFileSync(
    join(home, 'auth.json'),
    JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-x' }),
  );
  assert.throws(() => assertCodexHome(home), /not a ChatGPT login/);
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt' }));
  assert.doesNotThrow(() => assertCodexHome(home));
  writeFileSync(join(home, 'config.toml'), '[mcp_servers.neon]\n');
  assert.throws(() => assertCodexHome(home), /config\.toml/);
});
