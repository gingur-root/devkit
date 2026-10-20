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
import { render } from '../memory/render.ts';
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
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'publish-memory-'));
  const checkout = join(root, 'store');
  const out = join(root, 'out');
  const remote = join(root, 'remote.git');
  mkdirSync(checkout);
  mkdirSync(out);
  git(root, ['init', '--bare', remote]);
  git(checkout, ['init', '-b', 'main']);
  mkdirSync(join(checkout, 'memory/_org'), { recursive: true });
  writeFileSync(join(checkout, 'memory/_org/INDEX.md'), '# Org\n');
  writeFileSync(join(checkout, 'memory/MEMORY.md'), render(join(checkout, 'memory')));
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

test('valid memory becomes one pipeline PR from the pinned store, never main', async () => {
  const f = fixture();
  try {
    f.put('_org/a.md', entry());
    f.put('_org/INDEX.md', '- [a](a.md): A fact\n');
    await publishMemory({ ...job, memory: f.memory }, result, f.out, f.checkout);
    const posts = f.calls.filter((c) => c.method === 'POST');
    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.path, '/repos/gingur-root/pipeline/pulls');
    assert.equal(posts[0]!.body.head, 'memory/scratch-12');
    assert.equal(posts[0]!.body.base, 'main');
    assert.equal(posts[0]!.body.title, 'memory: scratch#12');
    assert.equal(posts[0]!.body.draft, false);
    assert.match(String(posts[0]!.body.body), /scratch\/pull\/12/);
    assert.equal(git(f.root, ['--git-dir', f.remote, 'rev-parse', 'main']), f.memory);
    assert.equal(git(f.root, ['--git-dir', f.remote, 'rev-parse', 'memory/scratch-12^']), f.memory);
  } finally {
    f.cleanup();
  }
});

test('delete removes the entry and regenerates MEMORY.md', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.checkout, 'memory/_org/a.md'), entry());
    writeFileSync(join(f.checkout, 'memory/_org/INDEX.md'), '- [a](a.md): A fact\n');
    writeFileSync(join(f.checkout, 'memory/MEMORY.md'), render(join(f.checkout, 'memory')));
    git(f.checkout, ['add', '.']);
    git(f.checkout, ['commit', '-m', 'entry'], { name: 'Fixture', email: 'fixture@example.com' });
    f.put('_org/a.md.delete', '');
    f.put('_org/INDEX.md', '# Org\n');
    await publishMemory(
      { ...job, memory: git(f.checkout, ['rev-parse', 'HEAD']) },
      result,
      f.out,
      f.checkout,
    );
    assert.equal(existsSync(join(f.checkout, 'memory/_org/a.md')), false);
    assert.equal(
      readFileSync(join(f.checkout, 'memory/MEMORY.md'), 'utf8'),
      render(join(f.checkout, 'memory')),
    );
  } finally {
    f.cleanup();
  }
});

test('empty and identical memory output open nothing', async () => {
  for (const identical of [false, true]) {
    const f = fixture();
    try {
      if (identical) f.put('_org/INDEX.md', '# Org\n');
      await publishMemory(
        { ...job, memory: f.memory },
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
    f.put('_org/INDEX.md', '- [a](a.md): A fact\n');
    await publishMemory({ ...job, memory: f.memory }, result, f.out, f.checkout);
    const pr = f.calls.find((c) => c.method === 'POST')!;
    assert.equal(pr.body.draft, true);
    assert.match(String(pr.body.body), /Memory check failed/);
    assert.match(String(pr.body.body), /quote not found in gingur-root\/scratch:README.md/);
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
    f.put('_org/INDEX.md', '- [a](a.md): A fact\n');
    await assert.rejects(
      publish({ in: input, out: f.out, checkout: f.checkout }),
      /different job, issue revision or plan/,
    );
    assert.equal(existsSync(join(f.checkout, 'memory/_org/a.md')), false);
    writeFileSync(resultFile, JSON.stringify(output));
    await publish({ in: input, out: f.out, checkout: f.checkout });
    assert.equal(f.calls.filter((call) => call.method === 'POST').length, 1);
    assert.equal(f.calls.filter((call) => call.path.includes('/contents/')).length, 1);
    assert.ok(
      f.calls.every(
        (call) =>
          call.path.startsWith('/repos/gingur-root/pipeline/') || call.path.includes('/contents/'),
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
    f.put('_org/INDEX.md', '- [a](a.md): A fact\n');
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
