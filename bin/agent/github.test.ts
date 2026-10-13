// The pipeline never merges. A merge call would succeed silently with the App
// token, so the one GitHub client refuses every merge route and mutation.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { graphql, rest } from './github.ts';

test('rest refuses the merge endpoints', async () => {
  await assert.rejects(rest('PUT', '/repos/o/r/pulls/7/merge'), /never merges/);
  await assert.rejects(rest('POST', '/repos/o/r/merges'), /never merges/);
});

test('graphql refuses merge and auto-merge mutations', async () => {
  for (const m of ['mergePullRequest', 'enablePullRequestAutoMerge', 'mergeBranch']) {
    await assert.rejects(
      graphql(`mutation { ${m}(input: {}) { clientMutationId } }`, {}),
      /never merges/,
    );
  }
});

test('text that mentions a merge still goes through', async () => {
  delete process.env.GH_TOKEN;
  await assert.rejects(rest('POST', '/repos/o/r/pulls', { body: 'calls mergeBranch' }), /GH_TOKEN/);
});
