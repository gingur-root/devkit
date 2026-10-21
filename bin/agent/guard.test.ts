import assert from 'node:assert/strict';
import { onTestFinished, test, vi } from 'vite-plus/test';

import { changedScripts, guardFindings } from './guard.ts';

function patch(path: string, removed: string[], added: string[]) {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -10,${removed.length} +10,${added.length} @@\n${removed.map((s) => `-${s}\n`).join('')}${added.map((s) => `+${s}\n`).join('')}`;
}

test('deleted and renamed-away tests remain blocking across reviews', () => {
  const deleted =
    'diff --git a/a.test.ts b/a.test.ts\ndeleted file mode 100644\n--- a/a.test.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-test("a", () => {});\n';
  const renamed =
    'diff --git a/a.test.ts b/a.ts\nsimilarity index 100%\nrename from a.test.ts\nrename to a.ts\n';
  for (const input of [deleted, renamed]) {
    const findings = guardFindings(input, '', []);
    assert.deepEqual(
      findings.map((f) => [f.id, f.blocking, f.path]),
      [['T-a.test.ts', true, 'a.test.ts']],
    );
  }
  assert.deepEqual(
    guardFindings(
      renamed.replace('b/a.ts', 'b/b.test.ts').replace('rename to a.ts', 'rename to b.test.ts'),
      '',
      [],
    ),
    [],
  );
});

test('removing cases is a hit while renaming a case is allowed', () => {
  assert.equal(guardFindings(patch('test/a.ts', ['test("a", () => {});'], []), '', []).length, 1);
  assert.deepEqual(
    guardFindings(patch('test/a.ts', ['test("a", () => {});'], ['test("b", () => {});']), '', []),
    [],
  );
});

test('new skip and focus markers are located only in test files', () => {
  for (const call of [
    'it.skip',
    'test.only',
    'describe.skipIf(true)',
    'xit',
    'xdescribe',
    'xtest',
    'fit',
    'fdescribe',
  ]) {
    const input = patch('src/a.spec.ts', [], ['// keep', `${call}('a', () => {});`]);
    const findings = guardFindings(input, '', []);
    assert.equal(findings.length, 1, call);
    assert.equal(findings[0]?.line, 11, call);
    assert.deepEqual(guardFindings(input.replaceAll('src/a.spec.ts', 'src/a.ts'), '', []), []);
  }
});

test('workflow and test/lint config changes are guarded, other config is not', () => {
  for (const path of [
    '.github/workflows/ci.yml',
    'vite.config.ts',
    'vitest.config.mts',
    'vitest.workspace.ts',
    'playwright.config.ts',
    'jest.config.js',
    'eslint.config.js',
    '.eslintrc.json',
    'configs/oxlintrc.base.json',
    '.oxlintrc.json',
    'configs/oxfmt.config.mjs',
    'prettier.config.mjs',
  ])
    assert.deepEqual(
      guardFindings(patch(path, ['old'], ['new']), '', []).map((f) => f.id),
      [`T-${path}`],
    );
  for (const path of ['bin/agent/publish.ts', 'tsconfig.json', 'components.json', 'package.json'])
    assert.deepEqual(guardFindings(patch(path, ['old'], ['new']), '', []), []);
});

test('only an exact path in the approved plan exempts a weakening', () => {
  const input = patch('packages/a/package.json', ['old'], ['new']);
  const paths = ['packages/a/package.json'];
  assert.equal(guardFindings(input, '', paths).length, 1);
  assert.equal(guardFindings(input, 'Edit `package.json`.', paths).length, 1);
  assert.deepEqual(guardFindings(input, 'Edit `packages/a/package.json`.', paths), []);
  assert.deepEqual(guardFindings(input, 'Edit packages/a/package.json.', paths), []);
  for (const text of [
    'other/packages/a/package.json',
    'packages/a/package.json.bak',
    'packages/a/package.json/child',
  ])
    assert.equal(guardFindings(input, text, paths).length, 1, text);
  const quoted = String.raw`diff --git "a/caf\303\251.test.ts" "b/caf\303\251.test.ts"
--- "a/caf\303\251.test.ts"
+++ "b/caf\303\251.test.ts"
@@ -1 +1 @@
-test('a', () => {});
+test.skip('a', () => {});
`;
  assert.equal(guardFindings(quoted, '', [])[0]?.path, 'café.test.ts');
});

test('script changes use committed package contents, ignore new packages, and surface API failures', async () => {
  vi.stubEnv('GH_TOKEN', 'test');
  const contents = new Map<string, unknown>([
    ['base', { scripts: { test: 'vitest' } }],
    ['head', { scripts: { test: 'true' } }],
  ]);
  let status = 200;
  const reads: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    reads.push(url);
    if (status !== 200) return new Response('lookup failed', { status });
    const pkg = contents.get(new URL(url).searchParams.get('ref')!);
    return Response.json({ content: Buffer.from(JSON.stringify(pkg)).toString('base64') });
  });
  onTestFinished(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  const input = patch('package.json', ['old'], ['new']);
  assert.deepEqual(await changedScripts('o/r', 'base', 'head', input), ['package.json']);
  contents.set('head', { scripts: { test: 'vitest' }, dependencies: {} });
  assert.deepEqual(await changedScripts('o/r', 'base', 'head', input), []);
  const count = reads.length;
  const added =
    'diff --git a/package.json b/package.json\nnew file mode 100644\n--- /dev/null\n+++ b/package.json\n@@ -0,0 +1 @@\n+{}\n';
  assert.deepEqual(await changedScripts('o/r', 'base', 'head', added), []);
  assert.equal(reads.length, count);
  const deleted =
    'diff --git a/package.json b/package.json\ndeleted file mode 100644\n--- a/package.json\n+++ /dev/null\n@@ -1 +0,0 @@\n-{}\n';
  assert.deepEqual(await changedScripts('o/r', 'base', 'head', deleted), ['package.json']);
  status = 404;
  assert.deepEqual(await changedScripts('o/r', 'base', 'head', input), []);
  status = 403;
  await assert.rejects(changedScripts('o/r', 'base', 'head', input), /403 lookup failed/);
});

test('renaming a workflow away cannot borrow approval for its destination', () => {
  const input =
    'diff --git a/.github/workflows/ci.yml b/notes.yml\nsimilarity index 100%\nrename from .github/workflows/ci.yml\nrename to notes.yml\n';
  assert.deepEqual(
    guardFindings(input, 'Edit `notes.yml`.', []).map((f) => f.id),
    ['T-.github/workflows/ci.yml'],
  );
  assert.deepEqual(guardFindings(input, 'Edit `.github/workflows/ci.yml`.', []), []);
});
