import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onTestFinished, test, vi } from 'vite-plus/test';

import { screen } from './screen.ts';

function fixture(script?: string) {
  const root = mkdtempSync(join(tmpdir(), 'screen-test-'));
  const out = join(root, 'out');
  mkdirSync(out);
  if (script !== undefined) {
    writeFileSync(join(root, 'gitleaks'), `#!${process.execPath}\n${script}`, { mode: 0o755 });
    vi.stubEnv('PATH', root);
  }
  onTestFinished(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, out };
}

test('screen stages only publishable files and additions, uses trusted rules, and cleans up', () => {
  const { root, out } = fixture(`
    const fs = require('node:fs');
    fs.cpSync('.', process.env.SCREEN_CAPTURE, { recursive: true });
    fs.writeFileSync(process.env.SCREEN_CAPTURE + '/args.json', JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
  `);
  const capture = join(root, 'capture');
  vi.stubEnv('SCREEN_CAPTURE', capture);
  for (const file of ['result.json', 'plan.md', 'research.md'])
    writeFileSync(join(out, file), file);
  writeFileSync(join(out, 'transcript.jsonl'), 'not publishable');
  writeFileSync(
    join(out, 'candidate.patch'),
    [
      'diff --git a/a b/a',
      '--- a/a',
      '+++ b/a',
      '@@ -1 +1,2 @@',
      '-removed',
      ' context',
      '+added',
      '+++also added',
      'diff --git a/b b/b',
      '--- a/b',
      '+++ b/b',
      '@@ -1 +1 @@',
      '+next',
    ].join('\n'),
  );
  mkdirSync(join(out, 'memory', 'nested'), { recursive: true });
  writeFileSync(join(out, 'memory', 'nested', 'entry.md'), 'memory');
  symlinkSync(join(out, 'result.json'), join(out, 'memory', 'link.md'));
  symlinkSync(out, join(out, 'memory', 'directory'));
  assert.equal(screen(out), null);
  assert.deepEqual(readdirSync(capture, { recursive: true }).sort(), [
    'args.json',
    'candidate.patch',
    'memory',
    'memory/nested',
    'memory/nested/entry.md',
    'plan.md',
    'research.md',
    'result.json',
  ]);
  assert.equal(readFileSync(join(capture, 'candidate.patch'), 'utf8'), 'added\n++also added\nnext');
  assert.equal(readFileSync(join(capture, 'memory/nested/entry.md'), 'utf8'), 'memory');
  const captured = JSON.parse(readFileSync(join(capture, 'args.json'), 'utf8'));
  const config = fileURLToPath(
    new URL('../../actions/secrets.scan/gitleaks.toml', import.meta.url),
  );
  assert.deepEqual(captured.args, [
    'dir',
    '--no-banner',
    '--redact',
    '--exit-code',
    '2',
    '--config',
    config,
    '-f',
    'json',
    '-r',
    join(captured.cwd, '../report.json'),
    '.',
  ]);
  assert.equal(existsSync(captured.cwd), false);
});

test('screen returns only file and rule and never forwards scanner diagnostics', () => {
  const token = 'gh' + 'p_' + 'A1b2C3d4'.repeat(4) + 'Zz9Y';
  const { out } = fixture(`
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    fs.writeFileSync(args[args.indexOf('-r') + 1], JSON.stringify([
      { File: 'plan.md', RuleID: 'github-pat', Secret: 'REDACTED', Match: 'REDACTED' }
    ]));
    console.log(${JSON.stringify(token)});
    console.error(${JSON.stringify(token)});
    process.exit(2);
  `);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  onTestFinished(() => {
    vi.restoreAllMocks();
  });
  const stop = screen(out);
  assert.equal(stop?.stage, 'validate');
  assert.match(stop!.reason, /plan.md \(github-pat\)/);
  assert.ok(!stop!.reason.includes(token));
  assert.deepEqual([...log.mock.calls, ...error.mock.calls], []);
});

test('screen fails closed for missing gitleaks, non-hit failures and unreadable reports', () => {
  const { root, out } = fixture();
  vi.stubEnv('PATH', root);
  assert.match(screen(out)!.reason, /could not run.*not found on PATH/);
  for (const script of [
    'process.exit(1);',
    'process.exit(2);',
    `require('node:fs').writeFileSync(process.argv[process.argv.indexOf('-r') + 1], '{'); process.exit(2);`,
    `require('node:fs').writeFileSync(process.argv[process.argv.indexOf('-r') + 1], '[]'); process.exit(2);`,
    `require('node:fs').writeFileSync(process.argv[process.argv.indexOf('-r') + 1], '[{}]'); process.exit(2);`,
  ]) {
    writeFileSync(join(root, 'gitleaks'), `#!${process.execPath}\n${script}`, { mode: 0o755 });
    const stop = screen(out);
    assert.equal(stop?.stage, 'validate');
    assert.match(stop!.reason, /could not run/);
  }
});

const gitleaks = spawnSync('gitleaks', ['version'], { encoding: 'utf8' });

test('screen checks decoded result strings', { skip: gitleaks.status !== 0 }, () => {
  const { out } = fixture();
  const token = 'gh' + 'p_' + 'A1b2C3d4'.repeat(4) + 'Zz9Y';
  const encoded = [...token]
    .map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .join('');
  writeFileSync(join(out, 'result.json'), `{"summary":"${encoded}"}`);
  const stop = screen(out);
  assert.equal(stop?.stage, 'validate');
  assert.match(stop!.reason, /result.json.*github-pat/);
  assert.ok(!stop!.reason.includes(token));
});

test(
  'pinned gitleaks screens every source and respects patch context and allow markers',
  {
    skip: gitleaks.status !== 0,
  },
  () => {
    assert.equal(gitleaks.stdout.trim(), '8.30.1');
    const { out } = fixture();
    const token = 'gh' + 'p_' + 'A1b2C3d4'.repeat(4) + 'Zz9Y';
    for (const file of [
      'result.json',
      'plan.md',
      'research.md',
      'memory/nested/entry.md',
      'candidate.patch',
    ]) {
      mkdirSync(join(out, 'memory/nested'), { recursive: true });
      writeFileSync(join(out, file), file === 'candidate.patch' ? `+${token}\n` : token);
      const stop = screen(out);
      assert.equal(stop?.stage, 'validate');
      assert.ok(stop!.reason.includes(file));
      assert.match(stop!.reason, /github-pat/);
      assert.ok(!stop!.reason.includes(token));
      rmSync(join(out, file));
    }
    for (const line of [`-${token}`, ` ${token}`, `+${token} // gitleaks:allow`]) {
      writeFileSync(
        join(out, 'candidate.patch'),
        `diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n${line}\n`,
      );
      assert.equal(screen(out), null);
    }
    writeFileSync(
      join(out, 'candidate.patch'),
      "+const sample = 'gh' + 'p_' + 'A1b2C3d4'.repeat(4) + 'Zz9Y';\n",
    );
    writeFileSync(
      join(out, 'result.json'),
      JSON.stringify({
        sha: 'f'.repeat(40),
        revision: 'a'.repeat(64),
        expression: '${{ secrets.X }}',
      }),
    );
    assert.equal(screen(out), null);
  },
);
