// The pipeline never merges, except `autoMerge` for memory PRs on pipeline (devkit#267).
// The public REST and GraphQL clients still refuse every merge route and mutation.
import assert from 'node:assert/strict';
import { test } from 'vite-plus/test';
import { graphql, rest } from './github.ts';
import * as github from './github.ts';

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

test("text that mentions a merge passes the guard, and a test never reaches the operator's gh login", async () => {
  delete process.env.GH_TOKEN;
  await assert.rejects(
    rest('POST', '/repos/o/r/pulls', { body: 'calls mergeBranch' }),
    /never fall back to the operator's gh login/,
  );
});

test('memory auto-merge helpers refuse every other repo before making a request', async () => {
  for (const repo of [
    'gingur-root/devkit',
    'gingur-root/infra',
    'other/pipeline',
    'gingur-root/pipeline-extra',
  ]) {
    await assert.rejects(
      async () => github.autoMerge(repo, { node_id: 'PR_99' }, 'checked-head'),
      (error: Error) => error.message.includes(repo) && error.message.includes('only'),
    );
    await assert.rejects(
      async () => github.disableAutoMerge(repo, { node_id: 'PR_99' }),
      (error: Error) => error.message.includes(repo) && error.message.includes('only'),
    );
  }
});
