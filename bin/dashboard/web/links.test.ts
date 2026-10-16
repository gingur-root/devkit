import assert from 'node:assert/strict';
import { test } from 'vite-plus/test';

import { cardRef } from './links.ts';

test('coordinator issue URLs map to dashboard threads, including links to comments', () => {
  for (const suffix of ['', '/', '#issuecomment-1', '?x=1', '/?x=1#issuecomment-1']) {
    assert.deepEqual(cardRef(`https://github.com/gingur-root/devkit/issues/132${suffix}`), {
      repo: 'devkit',
      number: 132,
    });
  }
  assert.deepEqual(cardRef('https://github.com/gingur-root/other.repo-name/issues/9'), {
    repo: 'other.repo-name',
    number: 9,
  });
});

test('other links stay external instead of mapping to a dashboard thread', () => {
  for (const href of [
    'https://github.com/other-org/devkit/issues/1',
    'https://github.com/gingur-root/devkit/pull/5',
    'https://github.com/gingur-root/devkit',
    'https://github.com/gingur-root/devkit/issues/abc',
    'https://github.com/gingur-root/devkit/issues/132/files',
    'https://github.com/gingur-root/devkit/issues/132extra',
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
