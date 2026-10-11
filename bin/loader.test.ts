// The loader is the reason devkit can ship TypeScript at all, and two of its
// details fail silently if dropped: oxc RETURNS syntax errors rather than
// throwing, and without an inline sourcemap a stack trace points at the
// post-transform line.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const LOADER = fileURLToPath(new URL('./loader.mjs', import.meta.url));

/** Run `source` as a .ts file through the loader, from a scratch directory. */
function runTs(source: string) {
  const dir = scratch('devkit-loader-');
  const file = join(dir, 'probe.ts');
  writeFileSync(file, source);
  return spawnSync(process.execPath, ['--import', LOADER, file], { encoding: 'utf8' });
}

/** A temp directory removed when the suite finishes, so runs do not leak. */
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('real TypeScript syntax runs', () => {
  const { status, stdout, stderr } = runTs(`
    interface Cfg { kind: 'passthrough' | 'parsed' }
    const c = { kind: 'parsed' } satisfies Cfg;
    console.log('ok ' + c.kind);
  `);
  assert.equal(status, 0, stderr);
  assert.match(stdout, /ok parsed/);
});

test('a syntax error fails loudly instead of producing wrong code', () => {
  // oxc's parser recovers and returns errors; without the errors check in
  // loader.mjs this would run silently-wrong code rather than failing.
  const { status, stderr } = runTs('const x: = ;\nconsole.log("should not print");');
  assert.notEqual(status, 0);
  assert.doesNotMatch(stderr, /should not print/);
});

test('a stack trace points at the real source line', () => {
  // Without the inline sourcemap this reports the post-transform line, which
  // sends you to the wrong place in the file.
  const source = [
    '',
    '',
    '',
    '',
    'function boom() {',
    '  throw new Error("kaboom");',
    '}',
    'boom();',
  ].join('\n');
  const { stderr } = runTs(source);
  assert.match(stderr, /kaboom/);
  assert.match(stderr, /probe\.ts:6/, `expected line 6, got:\n${stderr}`);
});
