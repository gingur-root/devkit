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
import {
  CANDIDATE_FILE,
  JOB_FILE,
  type Job,
  RESULT_FILE,
  REVIEW_FILE,
  THREADS_FILE,
  revision,
} from './job.ts';
import { loopComment, publish, readLoopState } from './publish.ts';
import { Result } from './result.ts';
import { readThreads } from './threads.ts';

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

function harness(
  options: {
    files?: { filename: string; previous_filename?: string }[];
    packages?: Record<string, string | null>;
    mergeError?: string;
    packageError?: number;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'publish-flow-'));
  const issue = { number: 1, node_id: 'issue', title: 'T', body: 'B', labels: [] };
  const pull = {
    number: 2,
    node_id: 'pr',
    html_url: 'https://github.com/o/r/pull/2',
    head: { sha: 'candidate' },
    base: { sha: 'github-base' },
  };
  const comments: Comment[] = [];
  const threads: ReturnType<typeof newThread>[] = [];
  const reads: string[] = [];
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  let calls = 0;
  vi.stubEnv('GH_TOKEN', 'test');
  vi.stubEnv('DEVKIT_APP_ONLY', '1');
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (init.method !== 'GET') writes.push({ path, body });
    else reads.push(url);
    let result: unknown;
    if (init.method === 'GET' && path.endsWith('/issues/1')) result = issue;
    else if (init.method === 'GET' && path.endsWith('/pulls')) result = [pull];
    else if (init.method === 'GET' && path.endsWith('/files')) {
      const page = Number(new URL(url).searchParams.get('page'));
      result = (options.files ?? [{ filename: 'STUB.md' }]).slice((page - 1) * 100, page * 100);
    } else if (init.method === 'GET' && path.endsWith('/contents/package.json')) {
      if (options.packageError)
        return new Response('package lookup failed', { status: options.packageError });
      const text = options.packages?.[new URL(url).searchParams.get('ref')!];
      if (text == null) return new Response('Not Found', { status: 404 });
      result = { content: Buffer.from(text).toString('base64'), encoding: 'base64' };
    } else if (init.method === 'GET' && path.endsWith('/reactions')) result = [];
    else if (init.method === 'GET' && path.endsWith('/comments')) {
      result = path.includes('/issues/2/') ? comments : [];
    } else if (path === '/graphql') {
      const { query, variables } = body;
      if (query.includes('mergePullRequest') && options.mergeError)
        return Response.json({ errors: [{ message: options.mergeError }] });
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
        user: { type: 'Bot', id: PIPELINE_BOT.id },
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
      checks?: Record<string, string>;
      verifier?: Result | null;
      verifierJob?: Partial<Job>;
      verifierJobText?: string;
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
      plan: options.checks
        ? { revision: 'approved', criteria: Object.keys(options.checks), checks: options.checks }
        : null,
      source: pull.head.sha,
      base: 'base',
      candidate: options.jobCandidate ?? pull.head.sha,
      memory: null,
      artifacts: [],
      operations: [],
      attemptLimit: null,
      baseMoved: false,
    };
    const matched = {
      ...result,
      job: job.job,
      inputs: {
        ...result.inputs,
        issue: job.issue.revision,
        plan: job.plan?.revision ?? null,
        candidate: options.candidate ?? job.candidate,
      },
    };
    writeFileSync(join(dir, THREADS_FILE), JSON.stringify(await readThreads('o/r', pull.number)));
    writeFileSync(join(dir, JOB_FILE), JSON.stringify(job));
    writeFileSync(join(dir, RESULT_FILE), JSON.stringify(matched));
    writeFileSync(
      join(dir, CANDIDATE_FILE),
      'diff --git a/STUB.md b/STUB.md\n--- a/STUB.md\n+++ b/STUB.md\n@@ -1 +1 @@\n-old\n+new\n',
    );
    if (options.review) writeFileSync(join(dir, REVIEW_FILE), JSON.stringify(options.review));
    const output = join(dir, 'github-output');
    writeFileSync(output, '');
    vi.stubEnv('GITHUB_OUTPUT', output);
    const verifierDir = join(dir, 'verifier');
    if (options.verifier) {
      mkdirSync(verifierDir);
      const verifierJob = { ...job, role: 'verify', ...options.verifierJob };
      writeFileSync(
        join(verifierDir, JOB_FILE),
        options.verifierJobText ?? JSON.stringify(verifierJob),
      );
      writeFileSync(
        join(verifierDir, RESULT_FILE),
        JSON.stringify({
          ...options.verifier,
          job: verifierJob.job,
          role: 'verify',
          inputs: {
            ...options.verifier.inputs,
            issue: verifierJob.issue.revision,
            plan: verifierJob.plan?.revision ?? null,
            candidate: options.verifier.inputs.candidate ?? verifierJob.candidate,
          },
        }),
      );
    }
    await publish({
      verifierIn: options.verifier !== undefined ? verifierDir : undefined,
      verifierOut: options.verifier !== undefined ? verifierDir : undefined,
      in: dir,
      out: dir,
      checkout: root,
      round,
      verified: options.verified ?? pull.head.sha,
      rounds: options.rounds,
    });
    return { dir, output: readFileSync(output, 'utf8') };
  }
  return { stage, pull, comments, reads, writes, threads };
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
  assert.equal(vi.mocked(setStatus).mock.lastCall?.[2], 'Done');
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
    verify: 'skipped',
    replan: null,
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

test('a failed repair thread reply keeps the pushed candidate available for review', async () => {
  const h = harness();
  await h.stage(changes, 0);
  const fetch = globalThis.fetch;
  let outputAtReply = '';
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (String(init.body).includes('addPullRequestReviewThreadReply')) {
      outputAtReply = readFileSync(process.env.GITHUB_OUTPUT!, 'utf8');
      return new Response(JSON.stringify({ errors: [{ message: 'thread reply denied' }] }));
    }
    return fetch(url, init);
  });
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  onTestFinished(() => errors.mockRestore());
  const result = await h.stage(
    {
      ...repair,
      changes: [{ ref: 'F1', change: 'fixed', response: null, evidence: null }],
    },
    1,
    { review: changes },
  );
  assert.equal(outputAtReply, 'candidate=repaired\n', 'output precedes thread replies');
  assert.equal(result.output, 'candidate=repaired\n');
  assert.notEqual(process.exitCode, 1, 'reply failure does not fail publication');
  assert.match(String(errors.mock.calls.flat().join(' ')), /GraphQL:.*thread reply denied/);
  assert.equal(vi.mocked(setStatus).mock.lastCall?.[2], 'Building');
  const state = readLoopState(h.comments[0]!.body);
  assert.equal(state.entries.at(-1)?.candidate, 'repaired');
  assert.notEqual(state.entries.at(-1)?.step, 'stop');
  h.pull.head.sha = 'repaired';
  const review = await h.stage(ready, 1);
  assert.match(review.output, /next=ready/);
  assert.equal(h.threads[0]!.isResolved, true, 'next review still resolves the fixed finding');
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

test('an inconclusive review retains open threads while still posting replies and new findings', async () => {
  const h = harness();
  await h.stage(changes, 0);
  const inconclusive = { ...ready, outcome: 'inconclusive' as const };
  const empty = await h.stage(inconclusive, 1);
  assert.match(empty.output, /next=stop/);
  assert.equal(h.threads[0]!.isResolved, false);
  assert.equal(vi.mocked(setStatus).mock.lastCall?.[2], 'Needs you');
  const stop = h.writes.filter((w) => w.path.endsWith('/issues/1/comments')).at(-1)!;
  assert.ok(String(stop.body.body).includes('[F1](https://github.com/o/r/pull/2#discussion-1)'));

  const f1 = changes.findings![0]!;
  await h.stage(
    {
      ...inconclusive,
      findings: [
        { ...f1, blocking: false },
        { ...f1, id: 'F2' },
      ],
    },
    2,
  );
  assert.equal(h.threads.length, 2);
  assert.deepEqual(
    h.threads.map((t) => t.isResolved),
    [false, false],
  );
  assert.equal(h.threads[0]!.comments.nodes.length, 2, 'reply on the existing F1 thread');
  assert.match(h.threads[0]!.comments.nodes[1]!.body, /\*\*F1\*\* advisory/);
  assert.match(h.threads[1]!.comments.nodes[0]!.body, /^<!-- devkit:finding F2 -->/);
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

test('the cap publication links open threads and includes the latest planner suggestion', async () => {
  const h = harness();
  await h.stage(changes, 0);
  const state = readLoopState(h.comments[0]!.body);
  state.entries[0]!.replan = 'Use the supported API.';
  h.comments[0]!.body = loopComment(state);
  const capped = await h.stage(changes, 10, { rounds: 10 });
  assert.match(capped.output, /next=stop/);
  const body = String(
    h.writes.filter((w) => w.path.endsWith('/issues/1/comments')).at(-1)!.body.body,
  );
  assert.match(body, /hasn't converged after 10 rounds/);
  assert.match(body, /Agents' suggestion: Use the supported API/);
  assert.match(body, /round 10/);
  assert.match(body, /\[F1\]\(https:\/\/github.com\/o\/r\/pull\/2#discussion-1\)/);
});

test('publication threads questions alongside findings and stops a question-only review', async () => {
  const h = harness();
  const review = { ...changes, questions: ['Which API?'] };
  const first = await h.stage(review, 0);
  assert.match(first.output, /next=repair/);
  assert.equal(h.threads.length, 2);
  assert.match(h.threads[1]!.comments.nodes[0]!.body, /^<!-- devkit:finding Q1 -->/);
  const gatedReview = JSON.parse(readFileSync(join(first.dir, REVIEW_FILE), 'utf8'));
  assert.deepEqual(gatedReview.questions, []);
  assert.deepEqual(
    gatedReview.findings.map((f: { id: string }) => f.id),
    ['F1', 'Q1'],
  );
  const second = await h.stage({ ...review, findings: [] }, 1);
  assert.match(second.output, /next=stop/);
});

test('publication threads verifier failures and resolves V-A1 only after fresh passing verification', async () => {
  const h = harness();
  const check = { ...ready, role: 'verify', axes: null, outcome: 'verified' as const };
  const failed = {
    ...check,
    evidence: ready.evidence.map((entry) => ({ ...entry, result: 'fail' as const })),
  };
  const first = await h.stage(ready, 0, { checks: { A1: 'agent' }, verifier: failed });
  assert.match(first.output, /next=repair/);
  const result = Result.parse(JSON.parse(readFileSync(join(first.dir, REVIEW_FILE), 'utf8')));
  assert.deepEqual(
    result.findings?.map((f) => [f.id, f.axis, f.blocking, f.criterion]),
    [['V-A1', 'spec', true, 'A1']],
  );
  assert.match(h.threads[0]!.comments.nodes[0]!.body, /V-A1/);
  assert.equal(h.threads[0]!.isResolved, false);
  const second = await h.stage(ready, 1, { checks: { A1: 'agent' }, verifier: check });
  assert.match(second.output, /next=ready/);
  assert.equal(h.threads[0]!.isResolved, true);
  assert.equal(readLoopState(h.comments[0]!.body).entries.at(-1)?.verify, 'verified');
});

test('publication stops and names missing verifier IDs, without marking Ready or resolving open findings', async () => {
  for (const verifier of [
    undefined,
    null,
    { ...ready, role: 'verify', outcome: 'verified' as const, evidence: [] },
  ]) {
    const h = harness();
    h.threads.push(newThread('<!-- devkit:finding V-A1 -->', 'STUB.md', 1, 1));
    const { output } = await h.stage(ready, 0, { checks: { A1: 'agent', A2: 'agent' }, verifier });
    assert.match(output, /next=stop/);
    const comment = h.writes.find((w) => w.path.endsWith('/issues/1/comments'));
    assert.match(String(comment?.body.body), /verifier.*A1, A2/);
    assert.equal(h.threads[0]!.isResolved, false);
    assert.ok(
      !h.writes.some((w) => String(w.body.query).includes('markPullRequestReadyForReview')),
    );
    assert.ok(vi.mocked(setStatus).mock.calls.some((args) => args[2] === 'Needs you'));
  }
});

test('publication stops stale verifier results and posts review findings on an unchanged head', async () => {
  for (const verifier of [
    {
      ...ready,
      outcome: 'verified' as const,
      inputs: { ...ready.inputs, candidate: 'candida' },
    },
    { ...ready, status: 'stale' as const, outcome: null, summary: 'Candidate superseded.' },
  ]) {
    for (const round of [0, 10]) {
      const h = harness();
      h.threads.push(newThread('<!-- devkit:finding V-A1 -->', 'STUB.md', 1, 1));
      const { output } = await h.stage(changes, round, { checks: { A1: 'agent' }, verifier });
      assert.match(output, /next=stop/);
      assert.doesNotMatch(output, /head=/);
      assert.equal(h.writes.filter((w) => w.path.endsWith('/reviews')).length, 1);
      assert.equal(h.threads.length, 2);
      assert.match(h.threads[1]!.comments.nodes[0]!.body, /^<!-- devkit:finding F1 -->/);
      assert.equal(h.threads[0]!.isResolved, false);
      const comment = h.writes.find((w) => w.path.endsWith('/issues/1/comments'))!;
      assert.match(String(comment.body.body), /stopped at `verify`/);
      assert.match(String(comment.body.body), /verifier.*A1/);
      assert.ok(
        String(comment.body.body).includes('[F1](https://github.com/o/r/pull/2#discussion-2)'),
      );
      assert.equal(vi.mocked(setStatus).mock.lastCall?.[2], 'Needs you');
      assert.ok(
        !h.writes.some((w) => String(w.body.query).includes('markPullRequestReadyForReview')),
      );
    }
  }
});

test('publication rejects a mismatched verifier contract', async () => {
  for (const verifierJob of [
    { plan: { revision: 'other', criteria: ['A1'], checks: { A1: 'agent' } } },
    { issue: { number: 99, title: 'T', revision: revision('T', 'B'), bodySeen: true } },
  ]) {
    const h = harness();
    const { output } = await h.stage(ready, 0, {
      checks: { A1: 'agent' },
      verifier: { ...ready, outcome: 'verified' },
      verifierJob,
    });
    assert.match(output, /next=stop/);
    assert.match(
      String(h.writes.find((w) => w.path.endsWith('/issues/1/comments'))?.body.body),
      /different.*issue revision or plan/,
    );
  }
});

test('a verifier stop retains the last judged open IDs in the loop log', async () => {
  const h = harness();
  const verifier = {
    ...ready,
    role: 'verify',
    outcome: 'failed' as const,
    evidence: ready.evidence.map((e) => ({ ...e, result: 'fail' as const })),
  };
  await h.stage(ready, 0, { checks: { A1: 'agent' }, verifier });
  await h.stage(ready, 1, { checks: { A1: 'agent' }, verifier: null });
  assert.deepEqual(readLoopState(h.comments[0]!.body).entries.at(-1)?.open, ['V-A1']);
  assert.equal(h.threads[0]!.isResolved, false);
});

test('a verifier stop posts the current review findings and links their IDs without clearing prior threads', async () => {
  for (const verifier of [null, { ...ready, outcome: 'inconclusive' as const }]) {
    const h = harness();
    h.threads.push(newThread('<!-- devkit:finding V-A1 -->', 'STUB.md', 1, 1));
    const { output } = await h.stage(changes, 0, { checks: { A1: 'agent' }, verifier });
    assert.match(output, /next=stop/);
    assert.equal(h.writes.filter((w) => w.path.endsWith('/reviews')).length, 1);
    assert.equal(h.threads.length, 2);
    assert.match(h.threads[1]!.comments.nodes[0]!.body, /^<!-- devkit:finding F1 -->/);
    assert.equal(h.threads[0]!.isResolved, false);
    const comment = h.writes.find((w) => w.path.endsWith('/issues/1/comments'))!;
    assert.match(String(comment.body.body), /verifier.*A1/);
    assert.ok(
      String(comment.body.body).includes('[F1](https://github.com/o/r/pull/2#discussion-2)'),
    );
    assert.equal(vi.mocked(setStatus).mock.lastCall?.[2], 'Needs you');
    assert.ok(
      !h.writes.some((w) => String(w.body.query).includes('markPullRequestReadyForReview')),
    );
  }
});

test('a malformed verifier job stops at contract and moves the card to Needs you', async () => {
  for (const verifierJobText of ['{}', '{']) {
    const h = harness();
    const { output } = await h.stage(ready, 0, {
      checks: { A1: 'agent' },
      verifier: { ...ready, outcome: 'verified' },
      verifierJobText,
    });
    assert.match(output, /next=stop/);
    const comment = h.writes.find((w) => w.path.endsWith('/issues/1/comments'))!;
    assert.match(String(comment.body.body), /stopped at `contract`/);
    assert.match(String(comment.body.body), /verifier.*A1.*job.json/);
    assert.equal(vi.mocked(setStatus).mock.lastCall?.[2], 'Needs you');
    assert.ok(
      !h.writes.some((w) => String(w.body.query).includes('markPullRequestReadyForReview')),
    );
  }
});

test('new questions get new threads past every open, resolved and current Q ID', async () => {
  const h = harness();
  await h.stage({ ...changes, questions: ['Original API question?'] }, 0);
  h.threads.push({
    ...newThread('<!-- devkit:finding Q20 -->', 'STUB.md', 1, 20),
    isResolved: true,
  });
  const second = await h.stage(
    {
      ...changes,
      findings: [...changes.findings!, { ...changes.findings![0]!, id: 'Q12', blocking: false }],
      questions: ['New API question?', 'Another question?'],
    },
    1,
  );
  const review = Result.parse(JSON.parse(readFileSync(join(second.dir, REVIEW_FILE), 'utf8')));
  assert.deepEqual(
    review.findings?.slice(-2).map((f) => f.id),
    ['Q21', 'Q22'],
  );
  assert.deepEqual(review.questions, []);
  assert.equal(h.threads[1]!.isResolved, true, 'the old question is resolved');
  for (const [id, text] of [
    ['Q21', 'New API question?'],
    ['Q22', 'Another question?'],
  ]) {
    const t = h.threads.find((t) =>
      t.comments.nodes[0]!.body.startsWith(`<!-- devkit:finding ${id} -->`),
    );
    assert.ok(t, id);
    assert.equal(t.isResolved, false, 'the new question stays open for the planner');
    assert.equal(t.comments.nodes.length, 1, 'a fresh thread, not a reply on the old one');
    assert.ok(t.comments.nodes[0]!.body.includes(text!));
  }
});

test('non-passing rounds preserve the base publication flow without merging', async () => {
  const h = harness();
  const requested = await h.stage(changes, 0);
  assert.match(requested.output, /next=repair\nrepair=true/);
  const fixed = await h.stage(
    { ...repair, changes: [{ ref: 'F1', change: 'fixed', response: null, evidence: null }] },
    1,
    { review: changes },
  );
  assert.match(fixed.output, /candidate=repaired/);
  const stale = await h.stage(ready, 1, { candidate: 'older' });
  assert.match(stale.output, /next=rerun/);
  const stopped = await h.stage(changes, 10, { rounds: 10 });
  assert.match(stopped.output, /next=stop/);
  assert.equal(
    h.writes.filter((w) =>
      /\b(mergePullRequest|enablePullRequestAutoMerge)\b/.test(String(w.body.query)),
    ).length,
    0,
  );
});

const mergeWrites = (h: ReturnType<typeof harness>) =>
  h.writes.filter((w) =>
    /\b(mergePullRequest|enablePullRequestAutoMerge)\b/.test(String(w.body.query)),
  );
const issueText = (h: ReturnType<typeof harness>) =>
  String(h.writes.filter((w) => w.path.endsWith('/issues/1/comments')).at(-1)!.body.body);
const auto = { ...ready, merge: { verdict: 'auto' as const, rule: null } };

test('a passing safe review squash-merges exactly the reviewed SHA and reports Done', async () => {
  const h = harness();
  await h.stage(auto, 0);
  const merges = mergeWrites(h);
  assert.equal(merges.length, 1);
  assert.match(String(merges[0]!.body.query), /mergePullRequest/);
  assert.deepEqual(merges[0]!.body.variables, {
    input: { pullRequestId: 'pr', mergeMethod: 'SQUASH', expectedHeadOid: 'candidate' },
  });
  assert.equal(vi.mocked(setStatus).mock.lastCall?.[2], 'Done');
  assert.match(issueText(h), /merged automatically/);
  assert.ok(h.writes.findIndex((w) => w.path.endsWith('/reviews')) < h.writes.indexOf(merges[0]!));
  assert.ok(
    h.writes.findIndex((w) => String(w.body.query).includes('markPullRequestReadyForReview')) <
      h.writes.indexOf(merges[0]!),
  );
});

for (const merge of [{ verdict: 'troy' as const, rule: 'product' }, null]) {
  test(`review verdict ${JSON.stringify(merge)} stops a safe PR`, async () => {
    const h = harness();
    await h.stage({ ...ready, merge }, 0);
    assert.equal(mergeWrites(h).length, 0);
    assert.equal(vi.mocked(setStatus).mock.lastCall?.[2], 'Needs you');
    assert.ok(issueText(h).includes(`\`${merge?.rule ?? 'review'}\``));
  });
}

test('GitHub files overrule a safe candidate.patch, summary and reviewer; all rules are named', async () => {
  const h = harness({ files: [{ filename: '.github/x.yml' }, { filename: 'src/auth.ts' }] });
  await h.stage({ ...auto, summary: 'Only STUB.md documentation changed.' }, 0);
  assert.equal(mergeWrites(h).length, 0);
  assert.equal(vi.mocked(setStatus).mock.lastCall?.[2], 'Needs you');
  assert.match(issueText(h), /needs you: `ci`, `auth`/);
});

test('reviewer rules add to code rules', async () => {
  const h = harness({ files: [{ filename: '.github/x.yml' }] });
  await h.stage({ ...ready, merge: { verdict: 'troy', rule: 'email' } }, 0);
  assert.equal(mergeWrites(h).length, 0);
  assert.match(issueText(h), /needs you: `ci`, `email`/);
});

test('files are paginated and both sides of a rename are checked', async () => {
  const h = harness({
    files: [
      ...Array.from({ length: 100 }, (_, n) => ({ filename: `docs/${n}.md` })),
      { filename: 'docs/moved.md', previous_filename: 'src/auth.ts' },
    ],
  });
  await h.stage(auto, 0);
  assert.equal(mergeWrites(h).length, 0);
  assert.match(issueText(h), /needs you: `auth`/);
  assert.ok(h.reads.some((url) => url.includes('/files?per_page=100&page=2')));
});

test('package comparison uses GitHub base and reviewed head, not the job base', async () => {
  const h = harness({
    files: [{ filename: 'package.json' }],
    packages: {
      'github-base': '{"dependencies":{"a":"1"}}',
      candidate: '{"dependencies":{"a":"2"},"scripts":{"test":"skip"}}',
      base: '{"dependencies":{"a":"2"},"scripts":{"test":"skip"}}',
    },
  });
  await h.stage(auto, 0);
  assert.equal(mergeWrites(h).length, 0);
  assert.match(issueText(h), /needs you: `ci`, `dependency`/);
  assert.deepEqual(
    h.reads
      .filter((url) => url.includes('/contents/package.json'))
      .map((url) => new URL(url).searchParams.get('ref'))
      .sort(),
    ['candidate', 'github-base'],
  );
});

test('a merge failure retains the posted review and names the error in Needs you', async () => {
  const h = harness({ mergeError: 'Expected head OID did not match' });
  await h.stage(auto, 0);
  assert.equal(mergeWrites(h).length, 1);
  assert.equal(h.writes.filter((w) => w.path.endsWith('/reviews')).length, 1);
  assert.equal(vi.mocked(setStatus).mock.lastCall?.[2], 'Needs you');
  assert.match(issueText(h), /Merging .* failed; needs you/);
  assert.match(issueText(h), /Expected head OID did not match/);
});

test('an unavailable trusted package lookup never merges', async () => {
  const h = harness({ packageError: 403 });
  await assert.rejects(h.stage(auto, 0), /403 package lookup failed/);
  assert.equal(mergeWrites(h).length, 0);
});
