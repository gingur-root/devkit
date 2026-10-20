// Exercise the controller's public publish seam, with GitHub and git writes
// captured locally. A helper passing must not hide a publish path bypassing it.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished, test, vi } from 'vite-plus/test';

import { git, gitAsOperator } from '../git.ts';
import { setStatus } from './board.ts';
import { PIPELINE_BOT } from './constants.ts';
import { type Comment } from './github.ts';
import { CANDIDATE_FILE, JOB_FILE, type Job, RESULT_FILE, REVIEW_FILE, revision } from './job.ts';
import { publish, readLoopState } from './publish.ts';
import { Result } from './result.ts';

vi.mock('./board.ts', () => ({ setStatus: vi.fn(), proposePriority: vi.fn() }));
vi.mock('../git.ts', () => ({ git: vi.fn(), gitAsOperator: vi.fn() }));

const ready = Result.parse(
  JSON.parse(readFileSync(new URL('fixtures/review.ready.json', import.meta.url), 'utf8')),
);
const changes = Result.parse(
  JSON.parse(readFileSync(new URL('fixtures/review.changes.json', import.meta.url), 'utf8')),
);
const repair = Result.parse(
  JSON.parse(readFileSync(new URL('fixtures/repair.ready.json', import.meta.url), 'utf8')),
);

function newThread(body: string, path: string, line: number | null, index: number) {
  return {
    id: `T${index}`,
    isResolved: false,
    path,
    line,
    comments: {
      nodes: [
        {
          body,
          url: `https://github.com/o/r/pull/2#discussion-${index}`,
          author: { login: 'pipeline', databaseId: PIPELINE_BOT.id },
        },
      ],
    },
  };
}

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'publish-flow-'));
  const issue = { number: 1, node_id: 'issue', title: 'T', body: 'B', labels: [] };
  const pull = {
    number: 2,
    node_id: 'pr',
    html_url: 'https://github.com/o/r/pull/2',
    head: { sha: 'candidate' },
  };
  const comments: Comment[] = [];
  const threads: ReturnType<typeof newThread>[] = [];
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  let calls = 0;
  vi.stubEnv('GH_TOKEN', 'test');
  vi.stubEnv('DEVKIT_APP_ONLY', '1');
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (init.method !== 'GET') writes.push({ path, body });
    let result: unknown;
    if (init.method === 'GET' && path.endsWith('/issues/1')) result = issue;
    else if (init.method === 'GET' && path.endsWith('/pulls')) result = [pull];
    else if (init.method === 'GET' && path.endsWith('/comments')) {
      result = path.includes('/issues/2/') ? comments : [];
    } else if (path === '/graphql') {
      const { query, variables } = body;
      if (query.includes('reviewThreads'))
        result = { data: { repository: { pullRequest: { reviewThreads: { nodes: threads } } } } };
      else {
        if (query.includes('resolveReviewThread'))
          threads.find((t) => t.id === variables.id)!.isResolved = true;
        if (query.includes('addPullRequestReviewThreadReply')) {
          const thread = threads.find((t) => t.id === variables.id)!;
          thread.comments.nodes.push({ ...thread.comments.nodes[0]!, body: variables.body });
        }
        result = { data: {} };
      }
    } else if (path.endsWith('/reviews')) {
      for (const comment of body.comments)
        threads.push(newThread(comment.body, comment.path, comment.line, threads.length + 1));
      result = {};
    } else if (path.endsWith('/pulls/2/comments')) {
      assert.equal(body.subject_type, 'file');
      threads.push(newThread(body.body, body.path, null, threads.length + 1));
      result = {};
    } else if (path.endsWith('/issues/2/comments')) {
      const comment: Comment = {
        id: comments.length + 10,
        html_url: `${pull.html_url}#issuecomment-${comments.length + 10}`,
        body: body.body,
        user: { type: 'Bot', id: 3 },
      };
      comments.push(comment);
      result = comment;
    } else if (path.includes('/issues/comments/')) {
      const comment = comments.find((c) => path.endsWith(`/${c.id}`));
      assert.ok(comment, path);
      comment.body = body.body;
      result = comment;
    } else if (path.endsWith('/issues/1/comments') || init.method === 'DELETE') result = {};
    else throw new Error(`Unexpected ${init.method} ${path}`);
    return new Response(JSON.stringify(result));
  });
  vi.mocked(git).mockReturnValue('repaired');
  const exitCode = process.exitCode;
  onTestFinished(() => {
    process.exitCode = exitCode;
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    rmSync(root, { recursive: true, force: true });
  });
  async function stage(
    result: Result,
    round: number,
    options: {
      verified?: string;
      rounds?: number;
      candidate?: string;
      jobCandidate?: string;
      review?: Result;
    } = {},
  ) {
    const dir = join(root, String(calls++));
    mkdirSync(dir);
    const role = result.role;
    const job: Job = {
      job: 'job',
      role,
      objective: '',
      repo: 'o/r',
      issue: {
        number: 1,
        title: issue.title,
        revision: revision(issue.title, issue.body),
        bodySeen: true,
      },
      plan: null,
      source: pull.head.sha,
      base: 'base',
      candidate: options.jobCandidate ?? pull.head.sha,
      memory: null,
      artifacts: [],
      operations: [],
      attemptLimit: null,
    };
    const matched = {
      ...result,
      job: job.job,
      inputs: {
        ...result.inputs,
        issue: job.issue.revision,
        candidate: options.candidate ?? job.candidate,
      },
    };
    writeFileSync(join(dir, JOB_FILE), JSON.stringify(job));
    writeFileSync(join(dir, RESULT_FILE), JSON.stringify(matched));
    writeFileSync(
      join(dir, CANDIDATE_FILE),
      'diff --git a/STUB.md b/STUB.md\n--- a/STUB.md\n+++ b/STUB.md\n@@ -1 +1 @@\n-old\n+new\n',
    );
    if (options.review) writeFileSync(join(dir, REVIEW_FILE), JSON.stringify(options.review));
    const output = join(dir, 'github-output');
    vi.stubEnv('GITHUB_OUTPUT', output);
    await publish({
      in: dir,
      out: dir,
      checkout: root,
      round,
      verified: options.verified ?? pull.head.sha,
      rounds: options.rounds,
    });
    return { dir, output: readFileSync(output, 'utf8') };
  }
  return { stage, pull, comments, writes, threads };
}

test('publish carries repair hypotheses into the same-round review and upserts one loop log', async () => {
  const h = harness();
  const first = await h.stage(changes, 0);
  assert.match(first.output, /next=repair\nrepair=true/);
  assert.equal(vi.mocked(setStatus).mock.lastCall?.[2], 'Building');
  assert.equal(h.comments.length, 1);
  assert.equal(h.threads.length, 1);
  assert.equal(h.threads[0]!.isResolved, false);
  assert.match(h.threads[0]!.comments.nodes[0]!.body, /^<!-- devkit:finding F1 -->/);
  const fixed = {
    ...repair,
    changes: [{ ref: 'F1', change: 'fixed', response: null, evidence: null }],
  };
  await h.stage(fixed, 1, { review: changes });
  assert.equal(vi.mocked(gitAsOperator).mock.calls.length, 1, 'a valid repair is pushed');
  assert.deepEqual(h.threads[0]!.comments.nodes.map((c) => c.body).slice(1), [
    'Repair `repaire`\n\nfixed',
  ]);
  h.pull.head.sha = 'repaired';
  const second = await h.stage(ready, 1);
  assert.match(second.output, /next=ready/);
  assert.equal(vi.mocked(setStatus).mock.lastCall?.[2], 'Ready');
  assert.equal(h.comments.length, 1);
  assert.equal(h.threads.length, 1, 'no duplicate F1 thread');
  assert.equal(h.threads[0]!.isResolved, true, 'next review resolves F1');
  const state = readLoopState(h.comments[0]!.body);
  assert.equal(state.entries.length, 2);
  assert.equal(state.failures, 1);
  assert.deepEqual(state.entries[1], {
    round: 1,
    candidate: 'repaired',
    ci: 'green',
    review: 'pass',
    open: [],
    hypotheses: ['stub hypothesis'],
    step: 'ready',
  });
  await h.stage(ready, 1);
  assert.deepEqual(readLoopState(h.comments[0]!.body), state, 'retry updates the same entry');
});

test('a stale review never posts a PR review or changes readiness, at or below the cap', async () => {
  const h = harness();
  for (const round of [0, 1, 10]) {
    const result = await h.stage(ready, round, {
      ...(round === 1 ? { jobCandidate: 'old-head' } : { candidate: 'older' }),
      rounds: 10,
    });
    const stopped = round === 10;
    assert.match(result.output, new RegExp(`next=${stopped ? 'stop' : 'rerun'}`));
    assert.ok(
      !h.writes.some(
        (w) =>
          w.path.endsWith('/reviews') ||
          (w.path === '/graphql' && String(w.body.query).includes('mutation')),
      ),
    );
    assert.ok(!result.output.includes('repair=true'));
    assert.equal(vi.mocked(setStatus).mock.lastCall?.[2], stopped ? 'Needs you' : 'Building');
    assert.equal(result.output.includes('retro=true'), stopped);
    assert.equal(
      readLoopState(h.comments[0]!.body).entries.at(-1)?.step,
      stopped ? 'stop' : 'rerun',
    );
    const comment = h.writes.filter((w) => w.path.endsWith('/issues/1/comments')).at(-1)!;
    if (stopped) assert.match(String(comment.body.body), /stopped at `stale`/);
    else {
      assert.match(result.output, /head=candidate\n/);
      assert.match(String(comment.body.body), /Re-reviewing `candida`:/);
      assert.ok(String(comment.body.body).includes(`Round ${round + 1} of 10`));
      assert.ok(!String(comment.body.body).includes('stopped at'));
      assert.notEqual(process.exitCode, 1);
    }
  }
  assert.ok(h.writes.some((w) => String(w.body.body).includes('the PR has a newer commit')));
});

test('the final failed review lists blocking IDs and links the single inline COMMENT review to its candidate', async () => {
  const h = harness();
  const result = await h.stage(
    {
      ...changes,
      findings: [...changes.findings!, { ...changes.findings![0]!, id: 'advice', blocking: false }],
    },
    1,
    { rounds: 1 },
  );
  assert.match(result.output, /next=stop/);
  assert.ok(!result.output.includes('repair=true'));
  const reviews = h.writes.filter((w) => w.path.endsWith('/reviews'));
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0]!.body.event, 'COMMENT');
  assert.equal(reviews[0]!.body.commit_id, 'candidate');
  assert.equal((reviews[0]!.body.comments as unknown[]).length, 2);
  assert.ok(
    !String(reviews[0]!.body.body).includes('**F1**'),
    'inline findings are omitted from the body',
  );
  const issueComment = h.writes.find((w) => w.path.endsWith('/issues/1/comments'))!;
  assert.match(String(issueComment.body.body), /round 1/);
  assert.ok(
    String(issueComment.body.body).includes('[F1](https://github.com/o/r/pull/2#discussion-1)'),
  );
  assert.ok(
    String(issueComment.body.body).includes('[advice](https://github.com/o/r/pull/2#discussion-2)'),
  );
  assert.ok(String(issueComment.body.body).includes(h.comments[0]!.html_url));
  assert.equal(vi.mocked(setStatus).mock.lastCall?.[2], 'Needs you');
});

test('red verification adds CI and hands it to repair; advisory-only green passes', async () => {
  const h = harness();
  const red = await h.stage(ready, 0, { verified: '' });
  assert.match(red.output, /next=repair/);
  const gated = JSON.parse(readFileSync(join(red.dir, REVIEW_FILE), 'utf8'));
  assert.deepEqual(
    gated.findings.map((f: { id: string }) => f.id),
    ['CI'],
  );
  assert.ok(
    !h.writes.some((w) => w.path === '/graphql' && String(w.body.query).includes('mutation')),
  );
  const advisory = { ...ready, findings: [{ ...changes.findings![0]!, blocking: false }] };
  const green = await h.stage(advisory, 1);
  assert.match(green.output, /next=ready/);
  assert.ok(
    h.writes.some(
      (w) =>
        w.path === '/graphql' && String(w.body.query).includes('markPullRequestReadyForReview'),
    ),
  );
});

test('an incomplete repair map stops at validate before any git write', async () => {
  const h = harness();
  await h.stage(changes, 0);
  await h.stage({ ...repair, changes: [] }, 1, { review: changes });
  assert.equal(vi.mocked(git).mock.calls.length, 0);
  assert.equal(vi.mocked(gitAsOperator).mock.calls.length, 0);
  assert.ok(
    h.writes.some(
      (w) =>
        String(w.body.body).includes('stopped at `validate`') && String(w.body.body).includes('F1'),
    ),
  );
  assert.equal(vi.mocked(setStatus).mock.lastCall?.[2], 'Needs you');
  const state = readLoopState(h.comments[0]!.body);
  assert.equal(state.entries.at(-1)?.round, 1);
  assert.equal(state.entries.at(-1)?.step, 'stop');
  assert.deepEqual(state.entries.at(-1)?.open, ['F1']);
});

test('a blocked repair logs its hypotheses without claiming a fix was pushed', async () => {
  const h = harness();
  await h.stage(changes, 0);
  const summary = 'No change: F1 is already fixed on this candidate.';
  const result = await h.stage(
    {
      ...repair,
      status: 'blocked',
      outcome: null,
      summary,
      changes: [
        { ref: 'F1', change: null, response: 'Already fixed', evidence: 'Checked the candidate' },
      ],
    },
    1,
    { review: changes },
  );
  assert.equal(vi.mocked(git).mock.calls.length, 0);
  assert.equal(vi.mocked(gitAsOperator).mock.calls.length, 0);
  assert.ok(!result.output.includes('candidate='));
  assert.equal(vi.mocked(setStatus).mock.lastCall?.[2], 'Needs you');
  const issueComment = h.writes.filter((w) => w.path.endsWith('/issues/1/comments')).at(-1)!;
  assert.match(String(issueComment.body.body), /\*\*Repair blocked\*\*/);
  assert.ok(String(issueComment.body.body).includes(summary));
  assert.ok(!String(issueComment.body.body).includes('pushed a fix'));
  assert.ok(!String(issueComment.body.body).includes('reviewing it again'));
  assert.equal(h.writes.filter((w) => w.path.endsWith('/reviews')).length, 1);
  assert.equal(h.comments.length, 1);
  const state = readLoopState(h.comments[0]!.body);
  assert.equal(state.entries.at(-1)?.candidate, 'candidate');
  assert.deepEqual(state.entries.at(-1)?.hypotheses, repair.hypotheses);
});

for (const status of ['blocked', 'failed'] as const) {
  test(`a ${status} repair with no map retains its summary in the validation stop`, async () => {
    const h = harness();
    const summary = 'Repair cannot continue: fixture access is unavailable.';
    await h.stage({ ...repair, status, outcome: null, summary, changes: null }, 1, {
      review: changes,
    });
    assert.equal(vi.mocked(git).mock.calls.length, 0);
    assert.equal(vi.mocked(gitAsOperator).mock.calls.length, 0);
    assert.equal(vi.mocked(setStatus).mock.lastCall?.[2], 'Needs you');
    const issueComment = h.writes.find((w) => w.path.endsWith('/issues/1/comments'))!;
    assert.match(String(issueComment.body.body), /stopped at `validate`/);
    assert.match(String(issueComment.body.body), /repair map is missing refs: F1/);
    assert.ok(String(issueComment.body.body).includes(summary));
  });
}

test('review publish replies on continuing IDs, resolves advisory IDs, and posts new off-diff threads on files', async () => {
  const h = harness();
  const f1 = changes.findings![0]!;
  await h.stage({ ...changes, findings: [f1, { ...f1, id: 'F2' }] }, 0);
  const start = h.writes.length;
  await h.stage(
    {
      ...changes,
      findings: [
        f1,
        { ...f1, id: 'F2', blocking: false },
        { ...f1, id: 'F3', path: 'off-diff.ts', line: 50 },
      ],
    },
    1,
    { rounds: 1 },
  );
  const round = h.writes.slice(start);
  const reviews = round.filter((w) => w.path.endsWith('/reviews'));
  assert.equal(reviews.length, 1);
  assert.deepEqual(reviews[0]!.body.comments, [], 'continuing IDs never duplicate inline threads');
  const file = round.find((w) => w.path.endsWith('/pulls/2/comments'))!;
  assert.equal(file.body.commit_id, 'candidate');
  assert.equal(file.body.path, 'STUB.md');
  assert.match(String(file.body.body), /^<!-- devkit:finding F3 -->\n\n`off-diff.ts:50`/);
  assert.equal(h.threads.length, 3);
  assert.deepEqual(
    h.threads.map((t) => t.isResolved),
    [false, true, false],
  );
  for (const t of h.threads.slice(0, 2)) assert.equal(t.comments.nodes.length, 2);
  const stop = round.find((w) => w.path.endsWith('/issues/1/comments'))!;
  assert.ok(String(stop.body.body).includes('[F1](https://github.com/o/r/pull/2#discussion-1)'));
  assert.ok(String(stop.body.body).includes('[F3](https://github.com/o/r/pull/2#discussion-3)'));
  assert.ok(!String(stop.body.body).includes('[F2]('));
});

test('a review stage failure names its round and links the existing open thread and loop log', async () => {
  const h = harness();
  await h.stage(changes, 0);
  const before = h.writes.length;
  await h.stage(
    { ...ready, status: 'failed', outcome: null, summary: 'Review fixture failed.' },
    1,
  );
  const writes = h.writes.slice(before);
  const stop = writes.find((w) => w.path.endsWith('/issues/1/comments'))!;
  assert.match(String(stop.body.body), /stopped at `review`/);
  assert.match(String(stop.body.body), /round 1/);
  assert.ok(String(stop.body.body).includes('[F1](https://github.com/o/r/pull/2#discussion-1)'));
  assert.ok(String(stop.body.body).includes(h.comments[0]!.html_url));
  assert.ok(!writes.some((w) => w.path.endsWith('/reviews')));
  assert.equal(h.threads[0]!.isResolved, false);
});
