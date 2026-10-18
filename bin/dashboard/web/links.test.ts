import assert from 'node:assert/strict';
import { test } from 'vite-plus/test';

import type { BoardCard } from '../board.ts';
import { githubRef, linkedCard } from './links.ts';

const cards: BoardCard[] = [
  {
    repo: 'devkit',
    number: 132,
    title: 'Chat links',
    url: 'https://github.com/gingur-root/devkit/issues/132',
    updatedAt: '2026-10-16T00:00:00Z',
    priority: 'P2',
    labels: [],
    column: 'Building',
    state: { column: 'Building', live: true },
    pulls: [{ repo: 'devkit', number: 149 }],
    subtasks: [{ repo: 'infra', number: 88, title: 'Runner', column: 'Ready' }],
  },
  {
    repo: 'infra',
    number: 132,
    title: 'Needs a decision',
    url: 'https://github.com/gingur-root/infra/issues/132',
    updatedAt: '2026-10-16T00:00:00Z',
    priority: null,
    labels: [],
    column: 'Needs you',
    state: { column: 'Needs you', live: false },
    pulls: [],
    subtasks: [],
  },
];

test('GitHub references accept issues, PRs and history URL suffixes', () => {
  for (const suffix of ['', '/', '?q=test', '#issuecomment-1', '/?q=test#issuecomment-1']) {
    assert.deepEqual(githubRef(`https://github.com/gingur-root/devkit/issues/132${suffix}`), {
      repo: 'devkit',
      number: 132,
      kind: 'issues',
    });
  }
  for (const suffix of ['', '/', '/files', '/files?diff=split#diff-1']) {
    assert.deepEqual(githubRef(`http://github.com/gingur-root/devkit/pull/149${suffix}`), {
      repo: 'devkit',
      number: 149,
      kind: 'pull',
    });
  }
  assert.deepEqual(githubRef('https://github.com/gingur-root/repo.name_2-3/issues/1'), {
    repo: 'repo.name_2-3',
    number: 1,
    kind: 'issues',
  });
});

test('other URLs and invalid references do not parse or map', () => {
  for (const href of [
    undefined,
    '',
    '#devkit/132',
    '/gingur-root/devkit/issues/132',
    'https://example.com',
    'https://github.com/other-org/devkit/issues/132',
    'https://github.com.evil.example/gingur-root/devkit/issues/132',
    'https://github.com/gingur-root/.repo/issues/132',
    'https://github.com/gingur-root/devkit/issues/0',
    'https://github.com/gingur-root/devkit/issues/-1',
    'https://github.com/gingur-root/devkit/issues/1.5',
    'https://github.com/gingur-root/devkit/issues/9007199254740993',
    'https://github.com/gingur-root/devkit/issues/132/extra',
    'https://github.com/gingur-root/devkit/pulls/149',
    'ftp://github.com/gingur-root/devkit/issues/132',
  ]) {
    assert.equal(githubRef(href), null, href);
    assert.equal(linkedCard(href, cards), null, href);
  }
});

test('issue links map to the matching card and its column, including Needs you', () => {
  assert.deepEqual(linkedCard('https://github.com/gingur-root/devkit/issues/132', cards), {
    repo: 'devkit',
    number: 132,
    column: 'Building',
  });
  assert.deepEqual(linkedCard('https://github.com/gingur-root/infra/issues/132', cards), {
    repo: 'infra',
    number: 132,
    column: 'Needs you',
  });
});

test('a subtask link opens the subtask, using its own column', () => {
  assert.deepEqual(linkedCard('https://github.com/gingur-root/infra/issues/88', cards), {
    repo: 'infra',
    number: 88,
    column: 'Ready',
  });
});

test('a PR link opens the issue it closes, including a link to changed files', () => {
  for (const suffix of ['', '/files#diff-1']) {
    assert.deepEqual(linkedCard(`https://github.com/gingur-root/devkit/pull/149${suffix}`, cards), {
      repo: 'devkit',
      number: 132,
      column: 'Building',
    });
  }
});

test('off-board issues and PRs stay external, even when their numbers match a card', () => {
  for (const path of [
    'devkit/issues/149',
    'devkit/pull/132',
    'infra/pull/149',
    'devkit/issues/999',
  ]) {
    assert.equal(linkedCard(`https://github.com/gingur-root/${path}`, cards), null, path);
  }
  assert.equal(linkedCard('https://github.com/gingur-root/devkit/issues/132', []), null);
});
