import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, vi } from 'vite-plus/test';
import { git } from '../git.ts';
import { type Job, revision } from './job.ts';
import { PIPELINE_BOT } from './constants.ts';
import { memoryChanges, memoryComment, publish, publishMemory } from './publish.ts';
import { Result } from './result.ts';

const entry = (quote = 'real evidence', evidence = true) =>
  `---\nname: a\ndescription: A fact\ntype: decision\ndate: 2026-10-20\nsource: merged code\nsupersedes: null\nevidence: ${evidence ? `\n  - at: gingur-root/scratch:README.md\n    quote: ${quote}` : '[]'}\n---\n\nA fact.\n`;
const job = {
  job: 'memory-1',
  role: 'memory',
  repo: 'gingur-root/scratch',
  issue: { number: 12, title: 'Merged', revision: 'rev', bodySeen: true },
  source: 'target',
  memory: null,
  plan: null,
  base: null,
  candidate: null,
  artifacts: [],
  operations: [],
  attemptLimit: null,
  objective: '',
} satisfies Job;
const result = Result.parse({
  ...JSON.parse(readFileSync(new URL('fixtures/retro.ready.json', import.meta.url), 'utf8')),
  job: job.job,
  role: job.role,
  outcome: 'implemented',
});
function fixture(
  options: {
    open?: { draft: boolean; auto_merge: object | null };
    enableError?: string;
    mergeError?: string;
    disableError?: string;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'publish-memory-'));
  const checkout = join(root, 'store');
  const out = join(root, 'out');
  const remote = join(root, 'remote.git');
  mkdirSync(checkout);
  mkdirSync(out);
  git(root, ['init', '--bare', remote]);
  git(checkout, ['init', '-b', 'main']);
  mkdirSync(join(checkout, 'memory/_org'), { recursive: true });
  writeFileSync(join(checkout, 'memory/_org/.gitkeep'), '');
  git(checkout, ['add', '.']);
  git(checkout, ['commit', '-m', 'seed'], { name: 'Fixture', email: 'fixture@example.com' });
  git(checkout, ['remote', 'add', 'origin', remote]);
  git(checkout, ['push', 'origin', 'main']);
  const memory = git(checkout, ['rev-parse', 'HEAD']);
  const calls: { method: string; path: string; body: Record<string, unknown> }[] = [];
  vi.stubEnv('GH_TOKEN', 'write');
  vi.stubEnv('CHECK_TOKEN', 'read');
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const method = init.method!;
    const body = init.body ? JSON.parse(String(init.body)) : {};
    calls.push({ method, path, body });
    if (path.includes('/contents/')) {
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer read');
      return Response.json({
        content: Buffer.from('real evidence').toString('base64'),
        encoding: 'base64',
      });
    }
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer write');
    if (path === '/graphql') {
      const query = String(body.query);
      const error = query.includes('enablePullRequestAutoMerge')
        ? options.enableError
        : query.includes('mergePullRequest')
          ? options.mergeError
          : query.includes('disablePullRequestAutoMerge')
            ? options.disableError
            : undefined;
      return Response.json(error ? { errors: [{ message: error }] } : { data: {} });
    }
    if (method === 'GET' && options.open)
      return Response.json([{ number: 99, node_id: 'PR_99', ...options.open }]);
    return Response.json(method === 'GET' ? [] : { number: 99, node_id: 'PR_99' });
  });
  const put = (path: string, text: string) => {
    const file = join(out, 'memory', path);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, text);
  };
  return {
    root,
    checkout,
    out,
    remote,
    memory,
    calls,
    put,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    },
  };
}

test('memory output refuses every path outside its slice and symlinks before applying anything', async () => {
  for (const path of [
    'other-repo/x.md',
    '_org/sub/x.md',
    'MEMORY.md',
    '_org/INDEX.md',
    '_org/x.txt',
    '_org/../x.md',
  ]) {
    const f = fixture();
    try {
      f.put('_org/a.md', entry());
      f.put(path, 'bad');
      await assert.rejects(
        publishMemory({ ...job, memory: f.memory }, result, f.out, f.checkout),
        /memory\/|INDEX|\.md/,
      );
      assert.equal(existsSync(join(f.checkout, 'memory/_org/a.md')), false);
      assert.equal(f.calls.length, 0);
    } finally {
      f.cleanup();
    }
  }
  for (const path of ['memory', 'memory/_org', 'memory/_org/a.md']) {
    const f = fixture();
    try {
      const target = join(f.root, 'target');
      mkdirSync(target);
      const file = join(f.out, path);
      mkdirSync(join(file, '..'), { recursive: true });
      symlinkSync(target, file);
      assert.throws(() => memoryChanges(f.out, job.repo), /symlink.*memory|memory.*symlink/i);
    } finally {
      f.cleanup();
    }
  }
});

test('a symlink stored in the pipeline checkout is refused before any write', async () => {
  const f = fixture();
  try {
    const target = join(f.root, 'target');
    mkdirSync(target);
    rmSync(join(f.checkout, 'memory/_org'), { recursive: true });
    symlinkSync(target, join(f.checkout, 'memory/_org'));
    git(f.checkout, ['add', '-A']);
    git(f.checkout, ['commit', '-m', 'link'], { name: 'Fixture', email: 'fixture@example.com' });
    f.put('_org/a.md', entry());
    await assert.rejects(
      publishMemory(
        { ...job, memory: git(f.checkout, ['rev-parse', 'HEAD']) },
        result,
        f.out,
        f.checkout,
      ),
      /memory\/_org: symlink refused/,
    );
    assert.equal(existsSync(join(target, 'a.md')), false);
    assert.equal(f.calls.length, 0);
  } finally {
    f.cleanup();
  }
});

test('valid memory becomes one pipeline PR from the pinned store, never main', async () => {
  const f = fixture();
  try {
    f.put('_org/a.md', entry());
    await publishMemory({ ...job, memory: f.memory }, result, f.out, f.checkout);
    const posts = f.calls.filter((c) => c.method === 'POST' && c.path !== '/graphql');
    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.path, '/repos/gingur-root/pipeline/pulls');
    assert.equal(posts[0]!.body.head, 'memory/scratch-12');
    assert.equal(posts[0]!.body.base, 'main');
    assert.equal(posts[0]!.body.title, 'memory: scratch#12');
    assert.equal(posts[0]!.body.draft, false);
    assert.match(String(posts[0]!.body.body), /scratch\/pull\/12/);
    assert.equal(git(f.root, ['--git-dir', f.remote, 'rev-parse', 'main']), f.memory);
    assert.equal(git(f.root, ['--git-dir', f.remote, 'rev-parse', 'memory/scratch-12^']), f.memory);
    const mutations = f.calls.filter((call) => call.path === '/graphql');
    assert.equal(mutations.length, 1);
    assert.match(String(mutations[0]!.body.query), /enablePullRequestAutoMerge/);
    assert.deepEqual(mutations[0]!.body.variables, {
      input: {
        pullRequestId: 'PR_99',
        mergeMethod: 'SQUASH',
        expectedHeadOid: git(f.root, ['--git-dir', f.remote, 'rev-parse', 'memory/scratch-12']),
      },
    });
  } finally {
    f.cleanup();
  }
});

test('delete removes the entry and commits no generated index', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.checkout, 'memory/_org/a.md'), entry());
    git(f.checkout, ['add', '.']);
    git(f.checkout, ['commit', '-m', 'entry'], { name: 'Fixture', email: 'fixture@example.com' });
    f.put('_org/a.md.delete', '');
    await publishMemory(
      { ...job, memory: git(f.checkout, ['rev-parse', 'HEAD']) },
      result,
      f.out,
      f.checkout,
    );
    assert.equal(existsSync(join(f.checkout, 'memory/_org/a.md')), false);
    assert.equal(existsSync(join(f.checkout, 'memory/MEMORY.md')), false);
    assert.equal(existsSync(join(f.checkout, 'memory/_org/INDEX.md')), false);
  } finally {
    f.cleanup();
  }
});

test('empty and identical memory output open nothing', async () => {
  for (const identical of [false, true]) {
    const f = fixture();
    try {
      let memory = f.memory;
      if (identical) {
        writeFileSync(join(f.checkout, 'memory/_org/a.md'), entry());
        git(f.checkout, ['add', '.']);
        git(f.checkout, ['commit', '-m', 'entry'], {
          name: 'Fixture',
          email: 'fixture@example.com',
        });
        memory = git(f.checkout, ['rev-parse', 'HEAD']);
        f.put('_org/a.md', entry());
      }
      await publishMemory(
        { ...job, memory },
        { ...result, outcome: identical ? 'implemented' : 'answered' },
        f.out,
        f.checkout,
      );
      assert.equal(f.calls.filter((c) => !c.path.includes('/contents/')).length, 0);
      assert.equal(git(f.root, ['--git-dir', f.remote, 'branch', '--list', 'memory/*']), '');
    } finally {
      f.cleanup();
    }
  }
});

test('a failed evidence check opens a draft containing the failure', async () => {
  const f = fixture();
  try {
    f.put('_org/a.md', entry('missing quote'));
    await publishMemory({ ...job, memory: f.memory }, result, f.out, f.checkout);
    const pr = f.calls.find((c) => c.method === 'POST')!;
    assert.equal(pr.body.draft, true);
    assert.match(String(pr.body.body), /Memory check failed/);
    assert.match(String(pr.body.body), /quote not found in gingur-root\/scratch:README.md/);
    assert.equal(f.calls.filter((call) => call.path === '/graphql').length, 0);
  } finally {
    f.cleanup();
  }
});

test.each(['added', 'edited'])(
  '%s entries check every quote outside the merged PR changed files',
  async (kind) => {
    const f = fixture();
    try {
      if (kind === 'edited') {
        writeFileSync(join(f.checkout, 'memory/_org/a.md'), entry());
        git(f.checkout, ['add', '.']);
        git(f.checkout, ['commit', '-m', 'entry'], {
          name: 'Fixture',
          email: 'fixture@example.com',
        });
      }
      f.put(
        '_org/a.md',
        entry().replace(
          'quote: real evidence',
          'quote: real evidence\n  - at: gingur-root/scratch:AGENTS.md\n    quote: missing quote',
        ),
      );
      await publishMemory(
        { ...job, memory: git(f.checkout, ['rev-parse', 'HEAD']) },
        result,
        f.out,
        f.checkout,
        ['gingur-root/scratch:src/other.ts'],
      );
      const pr = f.calls.find((call) => call.method === 'POST')!;
      assert.equal(pr.body.draft, true);
      assert.match(String(pr.body.body), /Memory check failed/);
      assert.match(String(pr.body.body), /quote not found in gingur-root\/scratch:AGENTS.md/);
      assert.deepEqual(
        f.calls.filter((call) => call.path.includes('/contents/')).map((call) => call.path),
        [
          '/repos/gingur-root/scratch/contents/README.md',
          '/repos/gingur-root/scratch/contents/AGENTS.md',
        ],
      );
    } finally {
      f.cleanup();
    }
  },
);

test('publish checks existing changed evidence and skips unrelated stored evidence', async () => {
  const f = fixture();
  try {
    for (const [name, path] of [
      ['a', 'src/other.ts'],
      ['b', 'unrelated.ts'],
    ] as const) {
      writeFileSync(
        join(f.checkout, `memory/_org/${name}.md`),
        entry('missing quote').replace('name: a', `name: ${name}`).replace('README.md', path),
      );
    }
    git(f.checkout, ['add', '.']);
    git(f.checkout, ['commit', '-m', 'entries'], { name: 'Fixture', email: 'fixture@example.com' });
    f.put('_org/c.md', entry().replace('name: a', 'name: c'));
    await publishMemory(
      { ...job, memory: git(f.checkout, ['rev-parse', 'HEAD']) },
      result,
      f.out,
      f.checkout,
      ['gingur-root/scratch:src/other.ts'],
    );
    const pr = f.calls.find((call) => call.method === 'POST')!;
    assert.equal(pr.body.draft, true);
    assert.match(String(pr.body.body), /quote not found in gingur-root\/scratch:src\/other.ts/);
    assert.deepEqual(
      f.calls.filter((call) => call.path.includes('/contents/')).map((call) => call.path),
      [
        '/repos/gingur-root/scratch/contents/src/other.ts',
        '/repos/gingur-root/scratch/contents/README.md',
      ],
    );
  } finally {
    f.cleanup();
  }
});

test('entries without evidence refuse the whole output before writes', async () => {
  const f = fixture();
  try {
    f.put('_org/a.md', entry('unused', false));
    await assert.rejects(
      publishMemory({ ...job, memory: f.memory }, result, f.out, f.checkout),
      /_org\/a.md.*evidence/,
    );
    assert.equal(existsSync(join(f.checkout, 'memory/_org/a.md')), false);
    assert.equal(f.calls.length, 0);
  } finally {
    f.cleanup();
  }
});

test('failure comment identifies the job and run with the memory marker', () => {
  const body = memoryComment(
    { start: { result: 'success' }, memory: { result: 'failure' }, publish: { result: 'skipped' } },
    'https://github.com/gingur-root/pipeline/actions/runs/1',
  );
  assert.match(body, /^<!-- devkit:memory -->/);
  assert.match(body, /memory/);
  assert.match(body, /actions\/runs\/1/);
  assert.match(body, /@gingur/);
  assert.match(memoryComment({}, 'run'), /unknown/);
});

test('publish binds memory to the recorded snapshot and uses only trusted changed paths', async () => {
  const f = fixture();
  try {
    const input = join(f.root, 'in');
    mkdirSync(input);
    const staged = {
      ...job,
      memory: f.memory,
      issue: { ...job.issue, revision: revision('Merged', 'Trusted', 'merge-sha') },
    };
    writeFileSync(join(input, 'job.json'), JSON.stringify(staged));
    writeFileSync(join(input, 'changed.txt'), 'gingur-root/scratch:README.md\n');
    const output = { ...result, inputs: { ...result.inputs, issue: staged.issue.revision } };
    const resultFile = join(f.out, 'result.json');
    writeFileSync(
      resultFile,
      JSON.stringify({ ...output, inputs: { ...output.inputs, issue: 'different-snapshot' } }),
    );
    f.put('_org/a.md', entry());
    await assert.rejects(
      publish({ in: input, out: f.out, checkout: f.checkout }),
      /different job, issue revision or plan/,
    );
    assert.equal(existsSync(join(f.checkout, 'memory/_org/a.md')), false);
    writeFileSync(resultFile, JSON.stringify(output));
    await publish({ in: input, out: f.out, checkout: f.checkout });
    assert.equal(f.calls.filter((call) => call.method === 'POST').length, 2);
    assert.equal(f.calls.filter((call) => call.path.includes('/contents/')).length, 1);
    assert.ok(
      f.calls.every(
        (call) =>
          call.path.startsWith('/repos/gingur-root/pipeline/') ||
          call.path.includes('/contents/') ||
          call.path === '/graphql',
      ),
    );
  } finally {
    f.cleanup();
  }
});

test('report updates one comment on the merged PR without a job artifact or board change', async () => {
  const calls: { method: string; path: string }[] = [];
  let comments: unknown[] = [];
  vi.stubEnv('GH_TOKEN', 'report');
  vi.stubEnv('CHECK_TOKEN', undefined);
  vi.stubEnv('GITHUB_SERVER_URL', 'https://github.com');
  vi.stubEnv('GITHUB_REPOSITORY', 'gingur-root/pipeline');
  vi.stubEnv('GITHUB_RUN_ID', '123');
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const method = init.method!;
    calls.push({ method, path });
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer report');
    if (method === 'GET') return Response.json(comments);
    const body = JSON.parse(String(init.body)).body;
    comments = [{ id: 88, body, user: { id: PIPELINE_BOT.id, type: 'Bot' } }];
    return Response.json(comments[0]);
  });
  try {
    const options = {
      in: '',
      out: '',
      repo: job.repo,
      issue: 12,
      failed: JSON.stringify({ start: { result: 'failure' } }),
    };
    await publish(options);
    await publish(options);
    assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
    assert.deepEqual(
      calls.filter((call) => call.method !== 'GET'),
      [
        { method: 'POST', path: '/repos/gingur-root/scratch/issues/12/comments' },
        { method: 'PATCH', path: '/repos/gingur-root/scratch/issues/comments/88' },
      ],
    );
    assert.match(JSON.stringify(comments), /pipeline\/actions\/runs\/123/);
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

test('updating an existing memory PR preserves one branch and sets the draft state', async () => {
  const f = fixture();
  try {
    f.put('_org/a.md', entry('missing quote'));
    const api = globalThis.fetch;
    const updates: { method: string; path: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === '/repos/gingur-root/pipeline/pulls' && init.method === 'GET')
        return Response.json([{ number: 99, node_id: 'PR_99', draft: false }]);
      if (path === '/repos/gingur-root/pipeline/pulls/99' || path === '/graphql') {
        updates.push({ method: init.method!, path, body: JSON.parse(String(init.body)) });
        return Response.json(path === '/graphql' ? { data: {} } : {});
      }
      return api(url, init);
    });
    await publishMemory({ ...job, memory: f.memory }, result, f.out, f.checkout);
    assert.equal(f.calls.filter((call) => call.method === 'POST').length, 0);
    assert.equal(updates[0]!.method, 'PATCH');
    assert.equal(updates[0]!.path, '/repos/gingur-root/pipeline/pulls/99');
    assert.match(JSON.stringify(updates[1]!.body), /convertPullRequestToDraft/);
  } finally {
    f.cleanup();
  }
});

for (const passed of [true, false]) {
  for (const draft of [true, false]) {
    for (const enabled of [true, false]) {
      test(`existing memory PR: passed=${passed}, draft=${draft}, auto_merge=${enabled}`, async () => {
        const f = fixture({ open: { draft, auto_merge: enabled ? {} : null } });
        try {
          f.put('_org/a.md', entry(passed ? 'real evidence' : 'missing quote'));
          await publishMemory({ ...job, memory: f.memory }, result, f.out, f.checkout);
          const writes = f.calls.filter((call) => call.method !== 'GET');
          assert.equal(writes[0]!.method, 'PATCH');
          assert.equal(writes[0]!.path, '/repos/gingur-root/pipeline/pulls/99');
          const mutations = writes.filter((call) => call.path === '/graphql');
          const names = mutations.map(
            (call) => String(call.body.query).match(/\b(\w+)\(input:/)![1],
          );
          const expected: string[] = [];
          if (passed && draft) expected.push('markPullRequestReadyForReview');
          if (enabled) expected.push('disablePullRequestAutoMerge');
          if (passed) expected.push('enablePullRequestAutoMerge');
          else if (!draft) expected.push('convertPullRequestToDraft');
          assert.deepEqual(names, expected);
          if (passed) {
            assert.deepEqual(mutations.at(-1)!.body.variables, {
              input: {
                pullRequestId: 'PR_99',
                mergeMethod: 'SQUASH',
                expectedHeadOid: git(f.root, [
                  '--git-dir',
                  f.remote,
                  'rev-parse',
                  'memory/scratch-12',
                ]),
              },
            });
          }
          assert.equal(
            git(f.root, ['--git-dir', f.remote, 'branch', '--list', 'memory/*']),
            'memory/scratch-12',
          );
        } finally {
          f.cleanup();
        }
      });
    }
  }
}

test('a clean-status enable error falls back to a squash merge of the pushed head', async () => {
  const f = fixture({ enableError: 'Pull request is in clean status' });
  try {
    f.put('_org/a.md', entry());
    await publishMemory({ ...job, memory: f.memory }, result, f.out, f.checkout);
    const mutations = f.calls.filter((call) => call.path === '/graphql');
    assert.equal(mutations.length, 2);
    assert.match(String(mutations[0]!.body.query), /enablePullRequestAutoMerge/);
    assert.match(String(mutations[1]!.body.query), /\bmergePullRequest\(/);
    const expected = {
      input: {
        pullRequestId: 'PR_99',
        mergeMethod: 'SQUASH',
        expectedHeadOid: git(f.root, ['--git-dir', f.remote, 'rev-parse', 'memory/scratch-12']),
      },
    };
    assert.deepEqual(mutations[0]!.body.variables, expected);
    assert.deepEqual(mutations[1]!.body.variables, expected);
  } finally {
    f.cleanup();
  }
});

test.each(['Auto-merge is not allowed', 'Expected head OID did not match'])(
  'an enable error rejects publishMemory without merging: %s',
  async (enableError) => {
    const f = fixture({ enableError });
    try {
      f.put('_org/a.md', entry());
      await assert.rejects(
        publishMemory({ ...job, memory: f.memory }, result, f.out, f.checkout),
        (error: Error) => error.message.includes(enableError),
      );
      const mutations = f.calls.filter((call) => call.path === '/graphql');
      assert.equal(mutations.length, 1);
      assert.match(String(mutations[0]!.body.query), /enablePullRequestAutoMerge/);
    } finally {
      f.cleanup();
    }
  },
);

test('a fallback merge error rejects publishMemory', async () => {
  const f = fixture({
    enableError: 'Pull request is in CLEAN STATUS',
    mergeError: 'Expected head OID did not match',
  });
  try {
    f.put('_org/a.md', entry());
    await assert.rejects(
      publishMemory({ ...job, memory: f.memory }, result, f.out, f.checkout),
      /Expected head OID did not match/,
    );
    assert.equal(f.calls.filter((call) => call.path === '/graphql').length, 2);
  } finally {
    f.cleanup();
  }
});

test('a disable error stops a failed rerun before converting the PR to a draft', async () => {
  const f = fixture({
    open: { draft: false, auto_merge: {} },
    disableError: 'Could not disable auto-merge',
  });
  try {
    f.put('_org/a.md', entry('missing quote'));
    await assert.rejects(
      publishMemory({ ...job, memory: f.memory }, result, f.out, f.checkout),
      /Could not disable auto-merge/,
    );
    const mutations = f.calls.filter((call) => call.path === '/graphql');
    assert.equal(mutations.length, 1);
    assert.match(String(mutations[0]!.body.query), /disablePullRequestAutoMerge/);
  } finally {
    f.cleanup();
  }
});

test('a staged path outside memory is refused before committing or pushing', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.checkout, 'stray.txt'), 'unrelated');
    git(f.checkout, ['add', 'stray.txt']);
    f.put('_org/a.md', entry());
    await assert.rejects(
      publishMemory({ ...job, memory: f.memory }, result, f.out, f.checkout),
      /stray\.txt.*outside memory\//,
    );
    assert.equal(git(f.checkout, ['rev-parse', 'HEAD']), f.memory);
    assert.equal(git(f.root, ['--git-dir', f.remote, 'branch', '--list', 'memory/*']), '');
    assert.equal(f.calls.length, 0);
  } finally {
    f.cleanup();
  }
});

test('a staged outside path with leading whitespace is refused without trimming its name', async () => {
  const f = fixture();
  try {
    mkdirSync(join(f.checkout, '\nmemory'));
    writeFileSync(join(f.checkout, '\nmemory/stray.md'), 'unrelated');
    git(f.checkout, ['add', '--', '\nmemory/stray.md']);
    f.put('_org/a.md', entry());
    await assert.rejects(
      publishMemory({ ...job, memory: f.memory }, result, f.out, f.checkout),
      /stray\.md.*outside memory\//,
    );
    assert.equal(git(f.checkout, ['rev-parse', 'HEAD']), f.memory);
    assert.equal(git(f.root, ['--git-dir', f.remote, 'branch', '--list', 'memory/*']), '');
    assert.equal(f.calls.length, 0);
  } finally {
    f.cleanup();
  }
});

test('a staged rename into memory cannot hide an outside deletion', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.checkout, 'stray.md'), entry());
    git(f.checkout, ['add', 'stray.md']);
    git(f.checkout, ['commit', '-m', 'outside entry'], PIPELINE_BOT);
    const memory = git(f.checkout, ['rev-parse', 'HEAD']);
    git(f.checkout, ['mv', 'stray.md', 'memory/_org/a.md']);
    f.put('_org/a.md', entry());
    await assert.rejects(
      publishMemory({ ...job, memory }, result, f.out, f.checkout),
      /stray\.md.*outside memory\//,
    );
    assert.equal(git(f.checkout, ['rev-parse', 'HEAD']), memory);
    assert.equal(git(f.root, ['--git-dir', f.remote, 'branch', '--list', 'memory/*']), '');
    assert.equal(f.calls.length, 0);
  } finally {
    f.cleanup();
  }
});
