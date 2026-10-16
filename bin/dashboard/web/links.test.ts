import assert from 'node:assert/strict';
import { test } from 'vite-plus/test';

import { cardRef } from './links.ts';

test('org issue links resolve to dashboard threads, including URL suffixes', () => {
  for (const suffix of ['', '/', '#issuecomment-1', '?x=1', '/?x=1#issuecomment-1']) {
    assert.deepEqual(cardRef(`https://github.com/gingur-root/devkit/issues/132${suffix}`), {
      repo: 'devkit',
      number: 132,
    });
  }
  assert.deepEqual(cardRef('https://github.com/gingur-root/another.repo-name/issues/7'), {
    repo: 'another.repo-name',
    number: 7,
  });
});

test('other links keep their external destination', () => {
  for (const href of [
    'https://github.com/other-org/devkit/issues/1',
    'https://github.com/gingur-root/devkit/pull/5',
    'https://github.com/gingur-root/devkit',
    'https://github.com/gingur-root/devkit/issues/abc',
    'https://github.com/gingur-root/devkit/issues/132/files',
    'https://github.com/gingur-root/devkit/issues/132abc',
    'https://github.com/gingur-root/devkit/issues/0',
    'https://github.com/gingur-root/devkit/issues/9007199254740993',
    'https://example.com/gingur-root/devkit/issues/1',
    'https://github.com.example.com/gingur-root/devkit/issues/1',
    'http://github.com/gingur-root/devkit/issues/1',
    '/gingur-root/devkit/issues/1',
    '#devkit/1',
    '',
    undefined,
  ]) {
    assert.equal(cardRef(href), null, href);
  }
});
