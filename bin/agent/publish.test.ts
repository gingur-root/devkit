// The review gate: a pass tells the operator the PR is safe to merge, so only a
// clean pass may say so. Filing subtasks and follow-ups writes new issues, so a
// retry must never file them twice.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, vi } from 'vite-plus/test';

import { OPERATOR_ID, PIPELINE_BOT } from './constants.ts';
import {
  capText,
  replanStopText,
  changedCriteria,
  specChanged,
  replanStep,
  replanMap,
  commitMessage,
  failureReason,
  fileFollowups,
  fileSubtasks,
  followupLine,
  gated,
  loopComment,
  needsYouText,
  nextStep,
  passes,
  planComment,
  publish,
  publishRetro,
  readyToBuild,
  readLoopState,
  repairMap,
  repairable,
  reviewComments,
  stopped,
  threadActions,
  replyChanges,
  verdict,
} from './publish.ts';
import type { Gate, LoopState } from './publish.ts';
import {
  CONTRACT_PREFIX,
  ISSUES_FILE,
  CHECKS_FILE,
  THREADS_FILE,
  JOB_FILE,
  type Job,
  marker,
  PLAN_FILE,
  PlanContract,
  RESULT_FILE,
  revision,
  STEPS_FILE,
  TRIAGE_FILE,
} from './job.ts';
import { approvedPlan } from './render.ts';
import type { Thread } from './threads.ts';
import { Result } from './result.ts';

const pass = Result.parse(
  JSON.parse(readFileSync(new URL('fixtures/review.ready.json', import.meta.url), 'utf8')),
);
const finding = {
  id: 'F1',
  axis: 'correctness',
  blocking: true,
  criterion: null,
  path: null,
  line: null,
  evidence: '',
  scenario: '',
  impact: '',
  fix: '',
} as const;

function check(job: Job, result: Result) {
  const out = mkdtempSync(join(tmpdir(), 'verdict-'));
  writeFileSync(join(out, PLAN_FILE), 'plan');
  writeFileSync(
    join(out, RESULT_FILE),
    JSON.stringify({
      ...result,
      job: job.job,
      role: job.role,
      inputs: {
        ...result.inputs,
        issue: job.issue.revision,
        plan: job.plan?.revision ?? null,
        candidate: job.candidate,
      },
    }),
  );
  return verdict(job, job.issue.revision, out);
}

const planJob: Job = {
  job: 'plan-1',
  role: 'plan',
  objective: '',
  repo: 'o/r',
  issue: { number: 1, title: 'T', revision: 'rev', bodySeen: true },
  plan: null,
  source: 'abc',
  base: null,
  candidate: null,
  memory: null,
  artifacts: [],
  operations: [],
  attemptLimit: null,
};

test('a ready plan that edits workflow files is approved like any other, and keeps body visibility', () => {
  const out = mkdtempSync(join(tmpdir(), 'plan-workflows-'));
  const ready = Result.parse(
    JSON.parse(readFileSync(new URL('fixtures/plan.ready.json', import.meta.url), 'utf8')),
  );
  try {
    for (const [plan, instruction] of [
      ['Edit `.github/workflows/agent.build.yml`.', 'reply `/approve` to build it'],
      ['Edit `.github/workflows/check.yaml`.', 'reply `/approve` to build it'],
      ['Edit `bin/agent/render.ts`.', 'reply `/approve` to build it'],
      ['Read `.github/workflows/` for context.', 'reply `/approve` to build it'],
    ] as const) {
      writeFileSync(join(out, PLAN_FILE), plan);
      for (const bodySeen of [true, false]) {
        const body = planComment(
          { ...planJob, issue: { ...planJob.issue, bodySeen } },
          ready,
          out,
          null,
          [],
        );
        const suffix = bodySeen
          ? ''
          : ' (written without the issue body, which someone else wrote)';
        assert.equal(body.split('\n\n')[1], `**Plan: ready: ${instruction}${suffix}**`);
      }
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('plan comments record body visibility and name a withheld body in every bold head', () => {
  const out = mkdtempSync(join(tmpdir(), 'plan-body-'));
  const ready = Result.parse(
    JSON.parse(readFileSync(new URL('fixtures/plan.ready.json', import.meta.url), 'utf8')),
  );
  writeFileSync(join(out, PLAN_FILE), 'plan');
  const variants = [
    { result: ready, handoff: null, story: [] },
    { result: ready, handoff: 'build', story: [] },
    { result: ready, handoff: null, story: [{ number: 2, title: 'Subtask', blockedBy: [] }] },
    { result: { ...ready, outcome: 'needs-input' }, handoff: null, story: [] },
    { result: { ...ready, status: 'failed', outcome: null }, handoff: null, story: [] },
    { result: { ...ready, triage: [] }, handoff: null, story: [] },
  ] as const;
  try {
    for (const bodySeen of [false, true]) {
      for (const variant of variants) {
        const body = planComment(
          { ...planJob, issue: { ...planJob.issue, bodySeen } },
          variant.result as Result,
          out,
          variant.handoff,
          variant.story.map((s) => ({ ...s, blockedBy: [...s.blockedBy] })),
        );
        const head = body.split('\n\n')[1]!;
        if (bodySeen) assert.doesNotMatch(head, /without the issue body/);
        else
          assert.match(
            head,
            /^\*\*Plan: .* \(written without the issue body, which someone else wrote\)\*\*$/,
          );
        const json = body.split(CONTRACT_PREFIX)[1]!.split(' -->')[0]!;
        assert.equal(PlanContract.parse(JSON.parse(json)).bodySeen, bodySeen);
      }
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

for (const status of ['blocked', 'failed'] as const) {
  test(`a ${status} result stops at its role with the reason`, () => {
    const result = { ...pass, status, outcome: null, summary: 'No fixture.', failure: null };
    for (const role of ['plan', 'build', 'review', 'retro']) {
      assert.deepEqual(check({ ...planJob, role }, result), {
        stage: role,
        reason: `\`${status}\`: No fixture`,
      });
    }
    assert.deepEqual(check(planJob, { ...result, outcome: 'ready' }), {
      stage: 'validate',
      reason: `a ${status} run set outcome \`ready\``,
    });
  });
}

test('a stale result stops at stale and names the superseded input', () => {
  for (const role of ['plan', 'build', 'repair', 'review', 'retro']) {
    assert.deepEqual(
      check(
        { ...planJob, role },
        {
          ...pass,
          status: 'stale',
          outcome: null,
          summary: 'The candidate changed.',
          failure: null,
        },
      ),
      {
        stage: 'stale',
        reason: `the ${role} found its input superseded: The candidate changed`,
      },
    );
  }
});

test('the gate binds every pass to the candidate and enforces the repair cap', () => {
  const gate: Gate = {
    candidate: 'new',
    head: 'new',
    verified: 'new',
    review: { result: pass },
    round: 0,
    rounds: 2,
  };
  assert.equal(nextStep(gate), 'ready');
  assert.equal(nextStep({ ...gate, head: 'newer' }), 'rerun');
  assert.equal(nextStep({ ...gate, head: 'newer', round: 2 }), 'stop');
  const stale = { stage: 'stale', reason: 'old candidate' };
  assert.equal(nextStep({ ...gate, review: stale }), 'rerun');
  assert.equal(nextStep({ ...gate, review: stale, round: 2 }), 'stop');
  assert.equal(nextStep({ ...gate, verified: 'old' }), 'repair');
  assert.equal(nextStep({ ...gate, verified: '' }), 'repair');
  assert.equal(nextStep({ ...gate, verified: 'old', round: 2 }), 'stop');
  assert.equal(nextStep({ ...gate, verified: '', round: 3 }), 'stop');
  assert.equal(nextStep({ ...gate, verified: '', rounds: 0 }), 'stop');
  assert.equal(nextStep({ ...gate, review: { stage: 'validate', reason: 'bad map' } }), 'stop');
  assert.equal(
    nextStep({
      ...gate,
      review: { result: { ...pass, findings: [{ ...finding, blocking: false }] } },
    }),
    'ready',
  );
  const changes = { ...pass, outcome: 'changes-requested' as const, findings: [finding] };
  assert.equal(nextStep({ ...gate, review: { result: changes } }), 'repair');
  assert.equal(nextStep({ ...gate, review: { result: changes }, round: 2 }), 'stop');
  assert.equal(nextStep({ ...gate, round: 2 }), 'ready', 'a final repaired candidate can pass');
});

test('candidate mismatches are stale, while other contract mismatches stay contract errors', () => {
  const job: Job = {
    job: 'review-1',
    role: 'review',
    objective: '',
    repo: 'o/r',
    issue: { number: 1, title: 'T', revision: 'rev', bodySeen: true },
    plan: null,
    source: 'new',
    base: null,
    candidate: 'new',
    memory: null,
    artifacts: [],
    operations: [],
    attemptLimit: null,
  };
  const out = mkdtempSync(join(tmpdir(), 'verdict-'));
  const result = {
    ...pass,
    job: job.job,
    inputs: { ...pass.inputs, issue: 'rev', candidate: 'old' },
  };
  writeFileSync(join(out, RESULT_FILE), JSON.stringify(result));
  assert.deepEqual(verdict(job, 'rev', out), {
    stage: 'stale',
    reason: 'the result is for commit old, not the current candidate new',
  });
  writeFileSync(join(out, RESULT_FILE), JSON.stringify({ ...result, job: 'other' }));
  assert.equal((verdict(job, 'rev', out) as { stage: string }).stage, 'contract');
});

const patch = `diff --git a/STUB.md b/STUB.md
--- a/STUB.md
+++ b/STUB.md
@@ -1,3 +1,3 @@
 context
-old
+new
 tail
@@ -20 +20,2 @@
 last
+added
diff --git a/deleted.md b/deleted.md
deleted file mode 100644
--- a/deleted.md
+++ /dev/null
@@ -1 +0,0 @@
-gone
`;

test('only RIGHT-side diff lines receive inline comments', () => {
  const findings = [
    { ...finding, path: 'STUB.md', line: 2 },
    { ...finding, id: 'F2', path: 'STUB.md', line: 20, blocking: false },
    { ...finding, id: 'F3', path: 'STUB.md', line: 10 },
    { ...finding, id: 'F4', path: 'absent.md', line: 2 },
    { ...finding, id: 'F5' },
    { ...finding, id: 'F6', path: 'deleted.md', line: 1 },
  ];
  const comments = reviewComments(patch, findings);
  assert.deepEqual(
    comments.inline.map(({ path, line, side }) => ({ path, line, side })),
    [
      { path: 'STUB.md', line: 2, side: 'RIGHT' },
      { path: 'STUB.md', line: 20, side: 'RIGHT' },
    ],
  );
  assert.match(
    comments.inline[0]!.body,
    /^<!-- devkit:finding F1 -->\n\n\*\*F1\*\* blocking · correctness/,
  );
  assert.match(
    comments.inline[1]!.body,
    /^<!-- devkit:finding F2 -->\n\n\*\*F2\*\* advisory · correctness/,
  );
  assert.deepEqual(
    comments.file.map(({ path }) => path),
    ['STUB.md', 'STUB.md', 'STUB.md', 'deleted.md'],
  );
  assert.match(comments.file[0]!.body, /^<!-- devkit:finding F3 -->\n\n`STUB.md:10`/);
  assert.match(comments.file[1]!.body, /^<!-- devkit:finding F4 -->\n\n`absent.md:2`/);
  assert.match(comments.file[2]!.body, /^<!-- devkit:finding F5 -->\n\nno location/);
  assert.deepEqual(comments.body, []);
  assert.deepEqual(reviewComments('', findings), { inline: [], file: [], body: findings });
});

test('inline comments accept Git-quoted UTF-8 paths', () => {
  const quoted = String.raw`diff --git "a/caf\303\251.md" "b/caf\303\251.md"
--- "a/caf\303\251.md"
+++ "b/caf\303\251.md"
@@ -0,0 +1 @@
+hello
`;
  const comments = reviewComments(quoted, [{ ...finding, path: 'café.md', line: 1 }]);
  assert.equal(comments.inline[0]?.path, 'café.md');
  assert.deepEqual(comments.body, []);
});

test('file anchors include rename-only, binary, deleted and Git-quoted files without new-side lines', () => {
  const files = [
    [
      'renamed.md',
      'diff --git a/old.md b/renamed.md\nsimilarity index 100%\nrename from old.md\nrename to renamed.md\n',
    ],
    [
      'image.png',
      'diff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ\n',
    ],
    ['deleted.md', patch.slice(patch.indexOf('diff --git a/deleted.md'))],
    [
      'café.md',
      String.raw`diff --git "a/caf\303\251.md" "b/caf\303\251.md"
old mode 100644
new mode 100755
`,
    ],
  ];
  for (const [path, diff] of files) {
    const comments = reviewComments(diff!, [{ ...finding, path: path!, line: 1 }]);
    assert.deepEqual(comments.inline, []);
    assert.deepEqual(comments.body, []);
    assert.equal(comments.file.length, 1);
    assert.equal(comments.file[0]!.path, path);
    assert.match(comments.file[0]!.body, /^<!-- devkit:finding F1 -->/);
  }
});

test('repair maps cover every finding and support every dispute with evidence', () => {
  const review = { ...pass, findings: [finding, { ...finding, id: 'F2' }] };
  const repair = {
    ...pass,
    changes: [
      { ref: 'F1', change: 'Fixed it', response: null, evidence: null },
      { ref: 'F2', change: null, response: 'Already works', evidence: 'command output' },
    ],
  };
  assert.equal(repairMap(review, repair), null);
  assert.match(repairMap(review, { ...repair, changes: repair.changes.slice(0, 1) })!, /F2/);
  assert.match(repairMap(review, { ...repair, changes: null })!, /F1.*F2/);
  for (const evidence of [null, '', '  ']) {
    assert.match(
      repairMap(review, {
        ...repair,
        changes: [repair.changes[0]!, { ...repair.changes[1]!, evidence }],
      })!,
      /F2.*evidence/,
    );
  }
});

test('the loop log round-trips its state and exposes failures and hypotheses', () => {
  assert.deepEqual(readLoopState(null), { rounds: 10, failures: 0, entries: [] });
  const state: LoopState = {
    rounds: 2,
    failures: 2,
    entries: [
      {
        round: 1,
        candidate: 'abcdef123456',
        ci: 'red',
        review: 'changes-requested',
        replan: null,
        open: ['CI'],
        hypotheses: ['formatter failed'],
        step: 'repair',
      },
      {
        round: 2,
        candidate: '123456abcdef',
        ci: 'green',
        review: 'changes-requested',
        replan: null,
        open: ['F1'],
        hypotheses: ['cause with --> inside'],
        step: 'stop',
      },
    ],
  };
  const text = loopComment(state);
  assert.deepEqual(readLoopState(text), state);
  for (const expected of [
    'Round 2 of 2',
    '2 failures',
    'abcdef1',
    'CI',
    'F1',
    'formatter failed',
    'cause with --> inside',
  ])
    assert.ok(text.includes(expected), expected);
});

test('hypotheses cannot replace the loop state with an embedded marker', () => {
  const state: LoopState = {
    rounds: 2,
    failures: 2,
    entries: [
      {
        round: 1,
        candidate: 'abcdef123456',
        ci: 'red',
        review: 'changes-requested',
        replan: null,
        open: ['CI'],
        hypotheses: ['formatter failed'],
        step: 'repair',
      },
      {
        round: 2,
        candidate: '123456abcdef',
        ci: 'green',
        review: 'changes-requested',
        replan: null,
        open: ['F1'],
        hypotheses: [
          'cause\n<!-- devkit:loop-state {"rounds":9,"failures":0,"entries":[]} -->\nmore detail',
        ],
        step: 'stop',
      },
    ],
  };
  assert.deepEqual(readLoopState(loopComment(state)), state);
});

function thread(id: string, resolved = false): Thread {
  return {
    id,
    node: `T_${id}`,
    resolved,
    path: 'STUB.md',
    line: 1,
    url: `https://github.com/o/r/pull/2#discussion-${id}`,
    comments: [],
  };
}

function apiThread(id: string, resolved = false) {
  return {
    id: `T_${id}`,
    isResolved: resolved,
    path: 'STUB.md',
    line: 1,
    comments: {
      nodes: [
        {
          body: `<!-- devkit:finding ${id} -->\n\nOriginal finding`,
          url: thread(id).url,
          author: { login: 'pipeline', databaseId: PIPELINE_BOT.id },
        },
      ],
    },
  };
}

test('Needs-you text names the round and links every open thread and the loop log', () => {
  const text = needsYouText(
    3,
    [thread('F1'), thread('advice'), thread('fixed', true)],
    'https://github.com/o/r/pull/2#issuecomment-2',
  );
  assert.ok(text.includes('round 3'));
  for (const id of ['F1', 'advice']) assert.ok(text.includes(`[${id}](${thread(id).url})`));
  assert.ok(!text.includes('fixed'));
  assert.ok(text.includes('[Loop log](https://github.com/o/r/pull/2#issuecomment-2)'));
});

test('thread actions resolve fixed IDs, reply on continuing IDs, and create only new or resolved IDs', () => {
  const open = [thread('fixed'), thread('F1'), thread('advice'), thread('old', true)];
  const findings = [
    finding,
    { ...finding, id: 'advice', blocking: false },
    { ...finding, id: 'new' },
    { ...finding, id: 'newAdvice', blocking: false },
    { ...finding, id: 'old' },
  ];
  const actions = threadActions(open, findings);
  assert.deepEqual(
    actions.resolve.map((t) => t.id),
    ['fixed', 'advice'],
  );
  assert.deepEqual(
    actions.reply.map(({ thread, finding }) => [thread.id, finding.id]),
    [
      ['F1', 'F1'],
      ['advice', 'advice'],
    ],
  );
  assert.deepEqual(
    actions.create.map((f) => f.id),
    ['new', 'newAdvice', 'old'],
  );
  assert.deepEqual(threadActions(open, []).resolve, open.slice(0, 3));
});

test('repair replies map changes and evidenced responses to open threads, skipping missing or resolved refs', async () => {
  const calls: { query: string; variables: { id: string; body: string } }[] = [];
  vi.stubEnv('GH_TOKEN', 'test');
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (body.query.includes('reviewThreads'))
      return Response.json({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [apiThread('F1'), apiThread('F2'), apiThread('resolved', true)],
              },
            },
          },
        },
      });
    calls.push(body);
    return Response.json({ data: {} });
  });
  try {
    await replyChanges(
      'o/r',
      2,
      [
        { ref: 'F1', change: 'Fixed the parser.', response: null, evidence: null },
        { ref: 'F2', change: null, response: 'Already works.', evidence: 'Repro exits 0.' },
        { ref: 'missing', change: 'No anchor.', response: null, evidence: null },
        { ref: 'resolved', change: 'Closed.', response: null, evidence: null },
      ],
      '123456789abcdef',
    );
    assert.deepEqual(
      calls.map((c) => c.variables),
      [
        { id: 'T_F1', body: 'Repair `1234567`\n\nFixed the parser.' },
        { id: 'T_F2', body: 'Repair `1234567`\n\nAlready works.\n\nRepro exits 0.' },
      ],
    );
    assert.ok(calls.every((c) => c.query.includes('addPullRequestReviewThreadReply')));
  } finally {
    teardown();
  }
});

test('only a clean pass passes', () => {
  assert.ok(passes(pass));
  assert.ok(!passes({ ...pass, outcome: 'changes-requested' }));
  assert.ok(!passes({ ...pass, outcome: 'inconclusive' }));
  assert.ok(!passes({ ...pass, axes: null }));
  assert.ok(!passes({ ...pass, axes: { ...pass.axes!, spec: 'changes-requested' } }));
  assert.ok(!passes({ ...pass, findings: [finding] }), 'a blocking finding');
  assert.ok(passes({ ...pass, findings: [{ ...finding, blocking: false }] }), 'advisory only');
  assert.ok(!passes({ ...pass, questions: ['Ship it?'] }), 'a question for the operator');
});

test('only findings with nothing to ask go to repair', () => {
  const asks = { ...pass, outcome: 'changes-requested' as const, findings: [finding] };
  assert.ok(repairable(asks));
  assert.ok(!repairable(pass), 'a pass');
  assert.ok(!repairable({ ...asks, findings: [] }), 'nothing to fix');
  assert.ok(!repairable({ ...asks, questions: ['Which API?'] }), 'a decision for the operator');
  assert.ok(!repairable({ ...asks, outcome: 'inconclusive' }), 'an inconclusive review');
});

test('only CI green on the reviewed commit itself reaches Ready', () => {
  const head = 'b'.repeat(40);
  assert.ok(passes(gated(pass, head, head)));
  assert.ok(!passes(gated(pass, head, '')), 'CI failed');
  assert.ok(!passes(gated(pass, head, 'a'.repeat(40))), 'CI passed on an earlier commit');
  assert.ok(!passes(gated(pass, null, '')), 'no candidate');
  assert.ok(repairable(gated(pass, head, '')), 'red CI goes to repair');
  const asks = { ...pass, outcome: 'inconclusive' as const };
  assert.ok(!repairable(gated(asks, head, '')), 'an inconclusive review still needs the operator');
});

test("a stop names the CLI's failure class and a rate limit's reset time", () => {
  const limited = { class: 'rate_limit', resetsAt: '2026-10-14T04:00:00.000Z' } as const;
  const body = stopped('plan', { stage: 'plan', reason: failureReason(limited, 'Hit a limit.') });
  assert.match(
    body,
    /stopped at `plan`:\*\* `rate_limit`, resets 2026-10-14 04:00 UTC: Hit a limit\./,
  );
  assert.ok(body.endsWith('Fix the cause, then add `agent:plan` again.'));
  assert.match(failureReason({ ...limited, resetsAt: null }, 'x'), /reset time unknown/);
});

test('every pushed commit lists the operator as co-author', () => {
  const issue = { number: 76, title: 'Add a thing', revision: '', bodySeen: true };
  for (const role of ['build', 'repair']) {
    const trailers = commitMessage({ role, issue }).split('\n\n').at(-1);
    assert.equal(
      trailers,
      'Co-authored-by: Troy Rhinehart <2553213+gingur@users.noreply.github.com>',
      role,
    );
  }
});

test('a plan hands off to a build only when it is ready with nothing to ask', () => {
  const plan = Result.parse(
    JSON.parse(readFileSync(new URL('fixtures/plan.ready.json', import.meta.url), 'utf8')),
  );
  assert.ok(readyToBuild(plan));
  assert.ok(!readyToBuild({ ...plan, questions: ['Which file?'] }));
  assert.ok(!readyToBuild({ ...plan, outcome: 'needs-input' }));
});

test('a missing result names the first failed setup step, but not a failed run', () => {
  const job: Job = {
    job: 'review-1',
    role: 'review',
    objective: '',
    repo: 'o/r',
    issue: { number: 1, title: 'T', revision: 'rev', bodySeen: true },
    plan: null,
    source: 'abc',
    base: null,
    candidate: null,
    memory: null,
    artifacts: [],
    operations: [],
    attemptLimit: null,
  };
  const out = mkdtempSync(join(tmpdir(), 'verdict-'));
  const missing = { stage: 'review', reason: 'the agent ended without a result' };
  assert.deepEqual(verdict(job, 'rev', out), missing, 'no out files');

  const steps = {
    pack: 'success',
    unpack: 'success',
    checkout: 'success',
    toolchain: 'failure',
    jobIn: 'skipped',
    secrets: 'skipped',
    run: 'skipped',
  };
  writeFileSync(join(out, STEPS_FILE), JSON.stringify(steps));
  const setupFailure = {
    stage: 'review',
    reason: 'the review job failed at toolchain before the agent started; see the job log',
    step: 'toolchain',
  };
  const body = stopped('review', setupFailure);
  assert.ok(
    body.endsWith(
      'Likely the environment (runner, Bitwarden), not the code: read step `toolchain` in job `review` before you reply `/approve` again.',
    ),
  );
  assert.doesNotMatch(body, /Fix the cause/);
  assert.deepEqual(verdict(job, 'rev', out), setupFailure, 'a failed setup step');

  writeFileSync(join(out, STEPS_FILE), JSON.stringify({ ...steps, jobIn: 'failure' }));
  assert.deepEqual(verdict(job, 'rev', out), setupFailure, 'the first failure in file order');

  writeFileSync(
    join(out, STEPS_FILE),
    JSON.stringify({ ...steps, toolchain: 'success', jobIn: 'success', run: 'failure' }),
  );
  assert.deepEqual(verdict(job, 'rev', out), missing, 'only run failed');
});

test("only a retro issue's plan triages, and every other plan sets a priority", () => {
  const plan = Result.parse(
    JSON.parse(readFileSync(new URL('fixtures/plan.ready.json', import.meta.url), 'utf8')),
  );
  const job: Job = {
    job: 'plan-1',
    role: 'plan',
    objective: '',
    repo: 'o/r',
    issue: { number: 1, title: 'T', revision: 'rev', bodySeen: true },
    plan: null,
    source: 'abc',
    base: null,
    candidate: null,
    memory: null,
    artifacts: [],
    operations: [],
    attemptLimit: null,
  };
  const retro = { ...job, artifacts: [ISSUES_FILE] };
  const triage = [{ title: 'Fix', body: 'b', link: null, start: 'plan', priority: 'P2' }] as const;
  const check = (j: Job, r: Result) => {
    const out = mkdtempSync(join(tmpdir(), 'verdict-'));
    writeFileSync(join(out, PLAN_FILE), 'plan');
    writeFileSync(
      join(out, RESULT_FILE),
      JSON.stringify({ ...r, job: j.job, role: j.role, inputs: { ...r.inputs, issue: 'rev' } }),
    );
    return verdict(j, 'rev', out);
  };
  assert.ok('result' in check(job, plan), 'an ordinary plan');
  assert.ok('result' in check(retro, { ...plan, triage: [...triage] }), 'a retro plan');
  assert.ok(
    'result' in check(retro, { ...plan, triage: [] }),
    'a retro plan that drops everything',
  );
  assert.match(
    String((check(job, { ...plan, triage: [...triage] }) as { reason: string }).reason),
    /only a retro/,
  );
  assert.match(String((check(retro, plan) as { reason: string }).reason), /no `triage`/);
  assert.ok(
    'result' in check(retro, { ...plan, outcome: 'needs-input', questions: ['Q?'] }),
    'a retro plan may still ask first',
  );
  assert.match(
    String((check(job, { ...plan, priority: null }) as { reason: string }).reason),
    /no `priority`/,
  );
  assert.ok('result' in check(retro, { ...plan, priority: null, triage: [] }), 'a retro plan');
});

test('a retro files one issue to plan, but only comments on a retro issue or with no findings', async () => {
  const retro = Result.parse(
    JSON.parse(readFileSync(new URL('fixtures/retro.ready.json', import.meta.url), 'utf8')),
  );
  const job = {
    repo: 'gingur-root/scratch',
    issue: { number: 1, title: 'T', revision: '', bodySeen: true },
  } as Job;
  const issue = {
    id: 1,
    number: 1,
    html_url: '',
    node_id: '',
    title: 'T',
    body: '',
    labels: [],
    created_at: '',
    user: null,
  };
  const writes: string[] = [];
  vi.stubEnv('GH_TOKEN', 'test');
  vi.stubEnv('GITHUB_SERVER_URL', 'https://github.com');
  vi.stubEnv('GITHUB_REPOSITORY', 'gingur-root/pipeline');
  vi.stubEnv('GITHUB_RUN_ID', '123');
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    writes.push(`${init.method} ${new URL(url).pathname} ${String(init.body)}`);
    return new Response(JSON.stringify({ number: 9 }), { status: 200 });
  });
  try {
    await publishRetro(job, issue, retro);
    assert.equal(writes.length, 3);
    assert.match(
      writes[0]!,
      /^POST \/repos\/gingur-root\/scratch\/issues .*"labels":\["retro","agent:filed"\]/,
    );
    assert.ok(writes[0]!.includes('https://github.com/gingur-root/pipeline/actions/runs/123'));
    assert.ok(!writes[0]!.includes('/gingur-root/scratch/actions/runs/'));
    assert.match(writes[1]!, /^POST \/repos\/gingur-root\/scratch\/issues\/9\/labels .*agent:plan/);
    assert.match(writes[2]!, /^POST \/repos\/gingur-root\/scratch\/issues\/1\/comments .*#9/);
    for (const [why, i, r] of [
      ['on a retro issue', { ...issue, labels: [{ name: 'retro' }] }, retro],
      ['no findings', issue, { ...retro, followups: [] }],
    ] as [string, typeof issue, Result][]) {
      writes.length = 0;
      await publishRetro(job, i, r);
      assert.equal(writes.length, 1, why);
      assert.match(writes[0]!, /^POST \/repos\/gingur-root\/scratch\/issues\/1\/comments /, why);
    }
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

const CARD = {
  id: 100,
  number: 1,
  html_url: '',
  node_id: 'I_1',
  title: 'Story',
  body: 'Body',
  labels: [],
  created_at: '2026-10-16T00:00:00Z',
  user: { id: OPERATOR_ID },
};

const fixtureResult = (name: string) =>
  Result.parse(JSON.parse(readFileSync(new URL(`fixtures/${name}.json`, import.meta.url), 'utf8')));

interface FakeIssue {
  id: number;
  number: number;
  node_id: string;
  title: string;
  body: string;
  labels: string[];
  user: { id: number };
}

/**
 * GitHub for the filing tests: the issues it files are listed on the next try,
 * and the board records each Status it sets. Every request lands in `calls` as
 * `<method> <path> <body>`.
 */
function fakeGitHub(card = CARD, comments: unknown[] = [], events: unknown[] = []) {
  const user = { id: PIPELINE_BOT.id };
  const issues: FakeIssue[] = [];
  const linked = new Set<number>();
  const dependencies = new Map<string, number[]>();
  const statuses: string[] = [];
  const calls: string[] = [];
  const board = {
    id: 'P',
    title: 'Pipeline',
    field: {
      id: 'F',
      options: ['Ask', 'Needs you', 'Building', 'Done', 'P2'].map((name) => ({ id: name, name })),
    },
  };
  vi.stubEnv('GH_TOKEN', 'test');
  vi.stubEnv('GITHUB_SERVER_URL', 'https://github.com');
  vi.stubEnv('GITHUB_REPOSITORY', 'gingur-root/pipeline');
  vi.stubEnv('GITHUB_RUN_ID', '123');
  vi.stubEnv('GITHUB_OUTPUT', '');
  vi.stubEnv('GITHUB_STEP_SUMMARY', '');
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const { pathname: path, search } = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push(`${method} ${path} ${init.body === undefined ? '' : String(init.body)}`);
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
    const issuesPath = `/repos/o/r/issues`;
    const cardPath = `${issuesPath}/${card.number}`;
    if (method === 'GET' && path === issuesPath) {
      assert.ok(search.includes(`since=${encodeURIComponent(card.created_at)}`), search);
      return json(
        search.includes('page=1')
          ? issues.map((issue) => ({
              ...issue,
              labels: issue.labels.map((name) => ({ name })),
            }))
          : [],
      );
    }
    if (method === 'POST' && path === issuesPath) {
      const n = issues.length + 2;
      const issue = { id: 1000 + n, number: n, node_id: `I_${n}`, labels: [], user, ...body };
      issues.push(issue);
      return json(issue);
    }
    if (path === `${cardPath}/sub_issues`) {
      if (method === 'POST') linked.add(body.sub_issue_id);
      return json(method === 'GET' ? issues.filter((i) => linked.has(i.id)) : {});
    }
    if (path.endsWith('/dependencies/blocked_by')) {
      const ids = dependencies.get(path) ?? [];
      if (method === 'POST') {
        assert.ok(!ids.includes(body.issue_id), 'no duplicate dependency');
        ids.push(body.issue_id);
        dependencies.set(path, ids);
        return json({});
      }
      return json(ids.map((id) => ({ id })));
    }
    if (method === 'GET' && path === cardPath) return json(card);
    if (method === 'GET' && path === `${cardPath}/comments`) return json(comments);
    if (method === 'GET' && path === `${cardPath}/events`) return json(events);
    if (method === 'GET' && path === `${cardPath}/reactions`) return json([]);
    if (method === 'POST' && path === '/graphql') {
      const { query, variables } = body as { query: string; variables: Record<string, string> };
      if (query.includes('organization('))
        return json({ data: { organization: { projectsV2: { nodes: [board] } } } });
      if (query.includes('addProjectV2ItemById'))
        return json({
          data: {
            addProjectV2ItemById: { item: { id: `item-${variables.content}`, current: null } },
          },
        });
      statuses.push(`${variables.item} ${variables.option}`);
      return json({ data: {} });
    }
    return json({ id: 1 });
  });
  return { issues, linked, statuses, calls };
}

function teardown() {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
}

const storyJob: Job = {
  job: 'plan-1',
  role: 'plan',
  objective: '',
  repo: 'o/r',
  issue: {
    number: 1,
    title: CARD.title,
    revision: revision(CARD.title, CARD.body),
    bodySeen: true,
  },
  plan: null,
  source: 'abc',
  base: null,
  candidate: null,
  memory: null,
  artifacts: [],
  operations: [],
  attemptLimit: null,
};

test('subtasks become sub-issues in Ask, and a retry files none twice', async () => {
  const github = fakeGitHub();
  const subtasks = fixtureResult('plan.story').subtasks!;
  try {
    const filed = await fileSubtasks(storyJob, CARD, subtasks);
    const posts = () => github.calls.filter((c) => c.startsWith('POST /repos/o/r/issues '));
    const links = () =>
      github.calls.filter((c) => c.startsWith('POST /repos/o/r/issues/1/sub_issues '));
    assert.equal(posts().length, 2);
    // The numeric id, not the number.
    assert.deepEqual(
      links().map((c) => JSON.parse(c.split(' ').slice(2).join(' '))),
      github.issues.map((i) => ({ sub_issue_id: i.id })),
    );
    assert.deepEqual(github.statuses, ['item-I_2 Ask', 'item-I_3 Ask']);
    assert.deepEqual(filed, [
      { number: 2, title: subtasks[0]!.title, blockedBy: [] },
      { number: 3, title: subtasks[1]!.title, blockedBy: [2] },
    ]);
    const edges = () =>
      github.calls.filter((c) => c.startsWith('POST ') && c.includes('/dependencies/blocked_by'));
    assert.deepEqual(edges(), [
      'POST /repos/o/r/issues/3/dependencies/blocked_by {"issue_id":1002}',
    ]);
    assert.ok(
      github.calls.indexOf(edges()[0]!) > github.calls.indexOf(links()[1]!),
      'edges follow all filing and linking',
    );

    // Nothing adds a stage label.
    const [plain, second] = github.issues;
    assert.deepEqual(plain!.labels, ['agent:filed']);
    assert.deepEqual(second!.labels, ['agent:filed']);
    assert.equal(plain!.body, `${subtasks[0]!.body}\n\nPart of #1.\n\n<!-- devkit:subtask #1 -->`);

    // A retry after a partial filing that never linked the second subtask.
    github.linked.delete(second!.id);
    github.calls.length = 0;
    github.statuses.length = 0;
    await fileSubtasks(storyJob, CARD, subtasks);
    assert.equal(posts().length, 0, 'no duplicate issue');
    assert.equal(edges().length, 0, 'no duplicate dependency');
    assert.deepEqual(links(), [
      `POST /repos/o/r/issues/1/sub_issues {"sub_issue_id":${second!.id}}`,
    ]);
    assert.deepEqual(github.statuses, ['item-I_3 Ask'], 'a started subtask stays where it is');
    assert.equal(github.issues.length, 2);

    // Someone else's copy of a subtask, marker and all, is never taken for it.
    github.issues.length = 0;
    github.issues.push({ ...plain!, id: 7, number: 7, user: { id: 1 } });
    github.calls.length = 0;
    await fileSubtasks(storyJob, CARD, subtasks.slice(0, 1));
    assert.equal(posts().length, 1);
    assert.ok(!links().some((c) => c.includes('"sub_issue_id":7')));
  } finally {
    teardown();
  }
});

test('invalid subtask dependencies fail before any issue is filed', async () => {
  const github = fakeGitHub();
  try {
    for (const index of [-1, 0, 1, 9]) {
      await assert.rejects(
        fileSubtasks(storyJob, CARD, [
          { title: 'Invalid', body: '', pr: true, blockedBy: [index] },
        ]),
        /earlier subtask/,
      );
    }
    await assert.rejects(
      fileSubtasks(storyJob, CARD, [
        { title: 'First', body: '', pr: true, blockedBy: null },
        { title: 'Invalid second', body: '', pr: true, blockedBy: [1] },
      ]),
      /earlier subtask/,
    );
    await assert.rejects(
      fileSubtasks(storyJob, CARD, [
        { title: 'Same', body: '', pr: true, blockedBy: null },
        { title: 'Same', body: '', pr: true, blockedBy: [0] },
      ]),
      /repeats the title/,
    );
    assert.ok(!github.calls.some((c) => c.startsWith('POST ')));
  } finally {
    teardown();
  }
});

test('plan contracts record dependency issue numbers and accept old plans without edges', () => {
  const out = mkdtempSync(join(tmpdir(), 'plan-edges-'));
  try {
    for (const [story, expected] of [
      [
        [
          { number: 2, title: 'First', blockedBy: [] },
          { number: 3, title: 'Second', blockedBy: [2] },
        ],
        { '3': [2] },
      ],
      [[{ number: 2, title: 'First', blockedBy: [] }], null],
      [[], null],
    ] as const) {
      const body = planComment(
        storyJob,
        fixtureResult('plan.ready'),
        out,
        null,
        story.map((s) => ({ ...s, blockedBy: [...s.blockedBy] })),
      );
      const raw = JSON.parse(body.split(CONTRACT_PREFIX)[1]!.split(' -->')[0]!);
      assert.deepEqual(raw.blockedBy, expected);
      assert.deepEqual(PlanContract.parse(raw).blockedBy, expected);
      delete raw.blockedBy;
      assert.equal(PlanContract.parse(raw).blockedBy, null);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('follow-up listings keep earlier issues once, sorted and separate from other stages', async () => {
  const github = fakeGitHub();
  const job = { ...storyJob, job: 'build-1', role: 'build' };
  const [first, second, third] = fixtureResult('build.followups').followups!;
  function listing(): string {
    const comment = github.calls
      .filter((c) => c.startsWith('POST /repos/o/r/issues/1/comments '))
      .at(-1)!;
    return JSON.parse(comment.split(' ').slice(2).join(' ')).body;
  }
  const buildListing =
    '<!-- devkit:followups:build -->\n\n**Follow-ups from the `build` stage**\n\n- #2 Stub follow-up 1\n- #3 Stub follow-up 2';
  try {
    await fileFollowups(job, CARD, 'build', [first!]);
    assert.equal(
      await fileFollowups(job, CARD, 'build', [second!]),
      'Filed 1 follow-up, listed below.',
    );
    assert.equal(listing(), buildListing);

    await fileFollowups(job, CARD, 'review.r1', [third!]);
    assert.equal(
      listing(),
      '<!-- devkit:followups:review.r1 -->\n\n**Follow-ups from the `review.r1` stage**\n\n- #4 Stub follow-up 3',
    );

    github.issues.reverse();
    await fileFollowups(job, CARD, 'build', [second!, first!]);
    assert.equal(listing(), buildListing);
    assert.equal(github.issues.length, 3, 'a retry files nothing');
  } finally {
    teardown();
  }
});

test('follow-ups carry only provenance in Ask, capped at 5 per stage, and once', async () => {
  const github = fakeGitHub();
  const job = { ...storyJob, job: 'build-1', role: 'build' };
  const seven = fixtureResult('build.followups').followups!;
  try {
    const line = await fileFollowups(job, CARD, 'build', seven.slice(0, 2));
    assert.equal(line, 'Filed 2 follow-ups, listed below.');
    const posts = github.calls.filter((c) => c.startsWith('POST /repos/o/r/issues '));
    assert.equal(posts.length, 2);
    for (const [i, issue] of github.issues.entries()) {
      assert.deepEqual(JSON.parse(posts[i]!.split(' ').slice(2).join(' ')).labels, ['agent:filed']);
      assert.equal(
        issue.body,
        `${seven[i]!.body}\n\nFrom #1's \`build\` stage ([run](https://github.com/gingur-root/pipeline/actions/runs/123)).\n\n<!-- devkit:followup #1 build -->`,
      );
    }
    assert.deepEqual(github.statuses, ['item-I_2 Ask', 'item-I_3 Ask']);
    const listing = github.calls.filter((c) => c.startsWith('POST /repos/o/r/issues/1/comments '));
    assert.equal(listing.length, 1);
    const comment = JSON.parse(listing[0]!.split(' ').slice(2).join(' ')).body as string;
    assert.ok(comment.startsWith(marker('followups:build')));
    assert.match(comment, /- #2 Stub follow-up 1\n- #3 Stub follow-up 2/);

    // Seven: the first five are filed, and a retry files nothing new.
    github.calls.length = 0;
    assert.equal(
      await fileFollowups(job, CARD, 'build', seven),
      'Filed 5 follow-ups, listed below. 2 more were dropped: the cap is 5 per stage.',
    );
    assert.equal(github.issues.length, 5);
    assert.deepEqual(
      github.issues.map((i) => i.title),
      seven.slice(0, 5).map((f) => f.title),
    );
    const before = github.calls.length;
    await fileFollowups(job, CARD, 'build', seven);
    assert.equal(github.issues.length, 5, 'a retry files nothing');
    assert.ok(!github.calls.slice(before).some((c) => c.startsWith('POST /repos/o/r/issues ')));
    // Another stage instance has its own cap and marker.
    await fileFollowups(job, CARD, 'review.r1', seven.slice(0, 1));
    assert.equal(github.issues.length, 6);
  } finally {
    teardown();
  }
  assert.equal(followupLine(0), '');
  assert.equal(followupLine(1), 'Filed 1 follow-up, listed below.');
  assert.equal(
    followupLine(6),
    'Filed 5 follow-ups, listed below. 1 more was dropped: the cap is 5 per stage.',
  );
});

test('subtasks and follow-ups ignore copied markers unless the issue is from the operator or labelled pipeline', async () => {
  for (const kind of ['subtask', 'followup'] as const) {
    for (const [id, labels, reuse] of [
      [PIPELINE_BOT.id, [], false],
      [PIPELINE_BOT.id, ['agent:filed'], true],
      [OPERATOR_ID, [], true],
      [1, ['agent:filed'], false],
    ] as const) {
      const github = fakeGitHub();
      const mark =
        kind === 'subtask' ? '<!-- devkit:subtask #1 -->' : '<!-- devkit:followup #1 build -->';
      github.issues.push({
        id: 7,
        number: 7,
        node_id: 'I_7',
        title: 'Same title',
        body: `Copied body\n\n${mark}`,
        labels: [...labels],
        user: { id },
      });
      try {
        if (kind === 'subtask') {
          const filed = await fileSubtasks(storyJob, CARD, [
            { title: 'Same title', body: 'Approved body', pr: true, blockedBy: null },
          ]);
          assert.equal(filed[0]!.number, reuse ? 7 : 3);
          assert.equal(github.linked.has(7), reuse);
        } else {
          await fileFollowups(storyJob, CARD, 'build', [
            { title: 'Same title', body: 'Approved body' },
          ]);
          const comment = github.calls.find((c) =>
            c.startsWith('POST /repos/o/r/issues/1/comments '),
          )!;
          assert.ok(comment.includes(`- #${reuse ? 7 : 3} Same title`));
        }
        const posts = github.calls.filter((c) => c.startsWith('POST /repos/o/r/issues '));
        assert.equal(posts.length, reuse ? 0 : 1, `${kind}, author ${id}, labels ${labels}`);
        if (!reuse) assert.ok(posts[0]!.includes('Approved body'));
      } finally {
        teardown();
      }
    }
  }
});

/** Writes the job and the agent's result as the run left them, and returns publish's options. */
function staged(job: Job, result: Result): { in: string; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'publish-'));
  const paths = { in: join(dir, 'in'), out: join(dir, 'out') };
  mkdirSync(paths.in);
  mkdirSync(paths.out);
  writeFileSync(join(paths.in, JOB_FILE), JSON.stringify(job));
  writeFileSync(join(paths.out, PLAN_FILE), 'plan');
  writeFileSync(
    join(paths.out, RESULT_FILE),
    JSON.stringify({
      ...result,
      job: job.job,
      role: job.role,
      inputs: { ...result.inputs, issue: job.issue.revision },
    }),
  );
  return paths;
}

test('a story plan lists its subtasks and never hands off, even after a Continue', async () => {
  // A dashboard Continue armed a hand-off: the App's comment, then its agent:plan.
  const comments = [
    { body: marker('continue'), created_at: '2026-10-16T01:00:00Z', user: { id: PIPELINE_BOT.id } },
  ];
  const events = [
    {
      event: 'labeled',
      created_at: '2026-10-16T01:00:10Z',
      actor: { id: PIPELINE_BOT.id },
      label: { name: 'agent:plan' },
    },
  ];
  const github = fakeGitHub(CARD, comments, events);
  const story = fixtureResult('plan.story');
  try {
    await publish(staged(storyJob, { ...story, followups: [{ title: 'Later', body: 'b' }] }));
    const posts = github.calls.filter((c) => c.startsWith('POST '));
    assert.ok(!posts.some((c) => c.includes('/labels')), 'no hand-off label');
    assert.ok(!github.calls.some((c) => c.includes('agent:build')));
    const stage = JSON.parse(
      posts
        .find((c) => c.includes(marker('plan')))!
        .split(' ')
        .slice(2)
        .join(' '),
    ).body as string;
    assert.ok(
      stage.includes(
        '**Plan: ready. This card is a story: approve and build each subtask, not this card**',
      ),
    );
    assert.ok(
      stage.includes(
        `## Subtasks\n\n- #2 ${story.subtasks![0]!.title}\n- #3 ${story.subtasks![1]!.title}`,
      ),
    );
    assert.ok(stage.includes('Filed 1 follow-up, listed below.'));
    assert.ok(stage.endsWith('@gingur'), 'a story plan waits on the operator');
    // The stage's comment comes before its follow-up is filed.
    const order = posts.map((c) =>
      c.includes(marker('plan')) ? 'stage' : c.includes('"Later"') ? 'followup' : '',
    );
    assert.ok(order.indexOf('stage') < order.indexOf('followup'));
    assert.equal(github.linked.size, 2);

    // The control: the same Continue hands an ordinary ready plan to its build.
    github.calls.length = 0;
    await publish(staged(storyJob, fixtureResult('plan.ready')));
    assert.ok(github.calls.includes('POST /repos/o/r/issues/1/labels {"labels":["agent:build"]}'));
  } finally {
    teardown();
  }
});

test('a retro files its findings as one retro issue, never as follow-ups', async () => {
  const github = fakeGitHub();
  const job = { ...storyJob, job: 'retro-1', role: 'retro' };
  try {
    await publish(staged(job, fixtureResult('retro.ready')));
    const filed = github.issues;
    assert.equal(filed.length, 1);
    assert.deepEqual(filed[0]!.labels, ['retro', 'agent:filed']);
    assert.ok(!github.calls.some((c) => c.includes('devkit:followup')));
  } finally {
    teardown();
  }
});

test('retro triage labels its issues with filing provenance', async () => {
  const github = fakeGitHub();
  const paths = staged({ ...storyJob, role: 'build' }, fixtureResult('build.ready'));
  writeFileSync(
    join(paths.in, TRIAGE_FILE),
    JSON.stringify([
      {
        title: 'Plain',
        body: 'One',
        link: null,
        start: 'backlog',
        priority: 'P2',
      },
      { title: 'Second', body: 'Two', link: null, start: 'plan', priority: 'P2' },
    ]),
  );
  try {
    await publish(paths);
    const posts = github.calls.filter((c) => c.startsWith('POST /repos/o/r/issues '));
    assert.deepEqual(
      posts.map((c) => JSON.parse(c.split(' ').slice(2).join(' ')).labels),
      [['agent:filed'], ['agent:filed']],
    );
    assert.ok(github.calls.includes('POST /repos/o/r/issues/3/labels {"labels":["agent:plan"]}'));
  } finally {
    teardown();
    rmSync(join(paths.in, '..'), { recursive: true, force: true });
  }
});

test('spec changes compare plan text and criterion checks, with null meaning unchanged', () => {
  const approved = { revision: revision('approved plan'), checks: { A1: 'ci', A2: 'agent' } };
  assert.equal(specChanged(approved, pass, null), false);
  assert.equal(specChanged(approved, pass, '  approved plan\n'), false);
  assert.equal(specChanged(approved, pass, 'changed plan'), true);
  const criteria = [
    { id: 'A1', text: 'Changed prose only', check: 'ci' },
    { id: 'A2', text: 'Two', check: 'agent' },
  ] as const;
  assert.equal(specChanged(approved, { ...pass, criteria: [...criteria] }, null), false);
  for (const [next, ids] of [
    [[], ['A1', 'A2']],
    [[criteria[0]], ['A2']],
    [[...criteria, { id: 'A3', text: 'Three', check: 'ci' }], ['A3']],
    [[{ ...criteria[0], check: 'agent' }, criteria[1]], ['A1']],
  ] as const) {
    const result = { ...pass, criteria: [...next] };
    assert.deepEqual(changedCriteria(approved.checks, result.criteria), ids);
    assert.equal(specChanged(approved, result, null), true);
  }
});

test('a planner can only add stops, and invalid results never reach repair', () => {
  const ready = { ...pass, outcome: 'ready' as const };
  assert.equal(replanStep({ result: ready }, false), 'repair');
  for (const outcome of [...Result.shape.outcome.unwrap().options, null]) {
    const result = { ...ready, outcome };
    assert.equal(replanStep({ result }, false), outcome === 'ready' ? 'repair' : 'stop');
    assert.equal(replanStep({ result }, true), 'spec');
  }
  for (const result of [
    { ...ready, outcome: 'needs-input' as const },
    { ...ready, questions: ['Change the interface?'] },
    { ...ready, status: 'blocked' as const, outcome: null },
  ]) {
    assert.equal(replanStep({ result }, false), 'stop');
    assert.equal(replanStep({ result }, true), 'spec');
  }
  assert.equal(replanStep({ result: ready }, true), 'spec');
  assert.equal(replanStep({ stage: 'validate', reason: 'invalid' }, true), 'stop');
});

test('planner replies must cover every unresolved thread', () => {
  assert.match(replanMap([thread('F1'), thread('F2', true)], pass) ?? '', /F1/);
  const result = {
    ...pass,
    changes: [{ ref: 'F1', change: null, response: 'Fix the parser.', evidence: null }],
  };
  assert.equal(replanMap([thread('F1'), thread('F2', true)], result), null);
  assert.match(
    replanMap([thread('F1')], { ...result, changes: [{ ...result.changes[0]!, response: ' ' }] }) ??
      '',
    /F1/,
  );
});

test('questions with blocking findings become planner threads; questions alone stop', () => {
  const review = {
    ...pass,
    outcome: 'changes-requested' as const,
    findings: [finding],
    questions: ['Which API?'],
  };
  const result = gated(review, 'head', 'head');
  assert.deepEqual(result.questions, []);
  assert.equal(result.findings?.[1]?.id, 'Q1');
  assert.equal(result.findings?.[1]?.blocking, false);
  const gate = { candidate: 'head', head: 'head', verified: 'head', round: 0, rounds: 10 };
  assert.equal(nextStep({ ...gate, review: { result: review } }), 'repair');
  assert.equal(nextStep({ ...gate, review: { result: { ...review, findings: [] } } }), 'stop');
  assert.deepEqual(gated({ ...pass, questions: ['CI?'] }, 'head', '').questions, []);
});

test('spec, planner and cap stops expose the round, open threads and the suggestion', () => {
  const threads = [thread('F1'), thread('Q1'), thread('closed', true)];
  const state = {
    rounds: 10,
    failures: 1,
    entries: [
      {
        round: 9,
        candidate: 'head',
        ci: null,
        review: null,
        replan: 'Fix the parser.',
        open: ['F1'],
        hypotheses: [],
        step: null,
      },
      {
        round: 10,
        candidate: 'head',
        ci: null,
        review: null,
        replan: 'Use the supported API.',
        open: ['F1'],
        hypotheses: [],
        step: 'stop',
      },
    ],
  } satisfies LoopState;
  for (const text of [
    replanStopText('spec', 10, ['A2', 'A5'], 'Added criteria.', threads, 'loop'),
    replanStopText('stop', 10, [], 'Need a decision.', threads, 'loop'),
    `${capText(10, state)}\n\n${needsYouText(10, threads, 'loop')}`,
  ]) {
    assert.ok(text.includes('round 10'));
    for (const t of threads.filter((t) => !t.resolved))
      assert.ok(text.includes(`[${t.id}](${t.url})`));
    assert.ok(!text.includes('[closed]'));
  }
  assert.match(replanStopText('spec', 1, ['A2', 'A5'], '', [], 'loop'), /Changed criteria: A2, A5/);
  assert.match(capText(10, state), /Agents' suggestion: Use the supported API/);
});

test('replan publication replies, gates changes, preserves approval, and stops an incomplete map', async () => {
  for (const scenario of [
    'repair',
    'spec',
    'checks-only',
    'questions',
    'inconclusive',
    'missing',
    'invalid',
    'blocked',
  ] as const) {
    const ready = fixtureResult('replan.ready');
    const replies = [
      { ref: 'F1', change: 'Use the response.', response: 'Fix the parser.', evidence: null },
      { ref: 'Q1', change: null, response: 'Use the existing API.', evidence: null },
    ];
    const job: Job = {
      ...planJob,
      role: 'replan',
      job: 'replan-1',
      issue: {
        number: 1,
        title: CARD.title,
        revision: revision(CARD.title, CARD.body),
        bodySeen: true,
      },
      plan: { revision: revision('approved plan'), criteria: ['A1'] },
      source: 'candidate-head',
      candidate: 'candidate-head',
      base: 'original-base',
    };
    const result = {
      ...ready,
      inputs: { ...ready.inputs, plan: job.plan!.revision, candidate: job.candidate },
      changes: scenario === 'missing' ? replies.slice(1) : replies,
      ...(scenario === 'checks-only' && {
        criteria: [{ id: 'A2', text: 'New criterion', check: 'ci' as const }],
      }),
      ...(scenario === 'questions' && {
        outcome: 'needs-input' as const,
        questions: ['Change the API?'],
      }),
      ...(scenario === 'inconclusive' && { outcome: 'inconclusive' as const }),
      ...(scenario === 'blocked' && { status: 'blocked' as const, outcome: null }),
    };
    const paths = staged(job, result);
    const output = join(paths.out, 'github-output');
    const github = fakeGitHub();
    const fallback = globalThis.fetch;
    const mutations: { id: string; body: string }[] = [];
    const bodies: string[] = [];
    const loop: LoopState = {
      rounds: 10,
      failures: 1,
      approved: job.plan!.revision,
      base: 'original-base',
      entries: [],
    };
    let log = {
      id: 50,
      user: { id: PIPELINE_BOT.id, type: 'Bot' },
      body: loopComment(loop),
      html_url: 'https://github.com/o/r/pull/2#loop',
    };
    writeFileSync(join(paths.in, PLAN_FILE), 'approved plan');
    writeFileSync(join(paths.in, CHECKS_FILE), JSON.stringify({ A1: 'ci' }));
    writeFileSync(join(paths.in, THREADS_FILE), JSON.stringify([thread('F1'), thread('Q1')]));
    if (scenario === 'spec') writeFileSync(join(paths.out, PLAN_FILE), 'new approved spec');
    else rmSync(join(paths.out, PLAN_FILE));
    if (scenario === 'invalid') writeFileSync(join(paths.out, RESULT_FILE), '{}');
    vi.stubEnv('GITHUB_OUTPUT', output);
    const exitCode = process.exitCode;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      const body = init.body === undefined ? undefined : JSON.parse(String(init.body));
      if (path === '/repos/o/r/pulls')
        return Response.json([{ number: 2, head: { sha: job.source } }]);
      if (path === '/repos/o/r/issues/2/comments') return Response.json([log]);
      if (path === '/repos/o/r/issues/comments/50') {
        log = { ...log, body: body.body };
        return Response.json(log);
      }
      if (path === '/repos/o/r/issues/1/comments' && init.method === 'POST') bodies.push(body.body);
      if (path === '/graphql' && body.query.includes('reviewThreads'))
        return Response.json({
          data: {
            repository: {
              pullRequest: { reviewThreads: { nodes: [apiThread('F1'), apiThread('Q1')] } },
            },
          },
        });
      if (path === '/graphql' && body.query.includes('addPullRequestReviewThreadReply')) {
        mutations.push(body.variables);
        return Response.json({ data: {} });
      }
      return fallback(url, init);
    });
    try {
      await publish({ ...paths, round: 3, rounds: 10 });
      const next = readFileSync(output, 'utf8');
      const expected =
        scenario === 'repair'
          ? 'repair'
          : scenario === 'spec' || scenario === 'checks-only'
            ? 'spec'
            : 'stop';
      assert.ok(next.includes(`next=${expected}`), `${scenario}: ${next}`);
      assert.ok(!next.includes('retro='));
      assert.equal(next.includes('repair=true'), expected === 'repair');
      assert.equal(mutations.length, scenario === 'missing' || scenario === 'invalid' ? 0 : 2);
      if (mutations.length)
        assert.match(mutations[0]!.body, /^Planner `candida`\n\nFix the parser/);
      const state = readLoopState(log.body);
      assert.equal(state.approved, job.plan!.revision);
      assert.equal(state.base, 'original-base');
      assert.equal(state.entries.at(-1)?.round, 3);
      const stage = bodies.find((b) => b.startsWith(marker('replan')))!;
      assert.ok(stage);
      if (expected !== 'repair') {
        assert.match(stage, /round 3/);
        assert.match(stage, /\[F1\]\(/);
        assert.ok(github.statuses.includes('item-I_1 Needs you'));
      }
      if (expected === 'spec') {
        const body = bodies.find((b) => b.startsWith(marker('plan')))!;
        assert.match(body, /reply `\/approve` to resume #2/);
        const plan = approvedPlan(
          [{ body, user: { id: OPERATOR_ID }, created_at: '' }],
          7,
          job.issue.revision,
          true,
        );
        assert.equal(plan.plan, scenario === 'spec' ? 'new approved spec' : 'approved plan');
        assert.deepEqual(plan.contract.checks, scenario === 'spec' ? { A1: 'ci' } : { A2: 'ci' });
        if (scenario === 'checks-only') {
          assert.match(stage, /Changed criteria: A1, A2/);
          assert.match(body, /Changed criteria: A1, A2/);
        }
      }
      if (scenario === 'missing') assert.match(stage, /validate.*missing replies: F1/);
    } finally {
      process.exitCode = exitCode;
      teardown();
      rmSync(join(paths.in, '..'), { recursive: true, force: true });
    }
  }
});
