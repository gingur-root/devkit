// The review gate: a pass tells the operator the PR is safe to merge, so only a
// clean pass may say so.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, vi } from 'vite-plus/test';

import {
  commitMessage,
  failureReason,
  gated,
  loopComment,
  needsYouText,
  nextStep,
  passes,
  publishRetro,
  readyToBuild,
  readLoopState,
  repairMap,
  repairable,
  reviewComments,
  stopped,
  verdict,
} from './publish.ts';
import type { Gate, LoopState } from './publish.ts';
import { ISSUES_FILE, type Job, PLAN_FILE, RESULT_FILE } from './job.ts';
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
  issue: { number: 1, title: 'T', revision: 'rev' },
  plan: null,
  source: 'abc',
  base: null,
  candidate: null,
  artifacts: [],
  operations: [],
  attemptLimit: null,
};

for (const status of ['blocked', 'failed'] as const) {
  test(`a ${status} result stops at its role with the reason`, () => {
    const result = { ...pass, status, outcome: null, summary: 'No fixture.', failure: null };
    for (const role of ['plan', 'build', 'review', 'retro', 'elevated']) {
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
  for (const role of ['plan', 'build', 'repair', 'review', 'retro', 'elevated']) {
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
    issue: { number: 1, title: 'T', revision: 'rev' },
    plan: null,
    source: 'new',
    base: null,
    candidate: 'new',
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
  assert.match(comments.inline[0]!.body, /^\*\*F1\*\* blocking · correctness/);
  assert.match(comments.inline[1]!.body, /^\*\*F2\*\* advisory · correctness/);
  assert.deepEqual(
    comments.body.map((f) => f.id),
    ['F3', 'F4', 'F5', 'F6'],
  );
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
  assert.deepEqual(readLoopState(null), { rounds: 2, failures: 0, entries: [] });
  const state: LoopState = {
    rounds: 2,
    failures: 2,
    entries: [
      {
        round: 1,
        candidate: 'abcdef123456',
        ci: 'red',
        review: 'changes-requested',
        open: ['CI'],
        hypotheses: ['formatter failed'],
        step: 'repair',
      },
      {
        round: 2,
        candidate: '123456abcdef',
        ci: 'green',
        review: 'changes-requested',
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
        open: ['CI'],
        hypotheses: ['formatter failed'],
        step: 'repair',
      },
      {
        round: 2,
        candidate: '123456abcdef',
        ci: 'green',
        review: 'changes-requested',
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

test('Needs-you text lists only open blocking findings and links the loop log', () => {
  const text = needsYouText(
    { ...pass, findings: [finding, { ...finding, id: 'advice', blocking: false }] },
    'https://github.com/o/r/pull/1#issuecomment-2',
  );
  assert.ok(text.includes('F1'));
  assert.ok(!text.includes('advice'));
  assert.ok(text.includes('https://github.com/o/r/pull/1#issuecomment-2'));
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
  assert.match(failureReason({ ...limited, resetsAt: null }, 'x'), /reset time unknown/);
});

test('every pushed commit lists the operator as co-author', () => {
  const issue = { number: 76, title: 'Add a thing', revision: '' };
  for (const role of ['build', 'repair', 'elevated']) {
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

test("only a retro issue's plan triages, and every other plan sets a priority", () => {
  const plan = Result.parse(
    JSON.parse(readFileSync(new URL('fixtures/plan.ready.json', import.meta.url), 'utf8')),
  );
  const job: Job = {
    job: 'plan-1',
    role: 'plan',
    objective: '',
    repo: 'o/r',
    issue: { number: 1, title: 'T', revision: 'rev' },
    plan: null,
    source: 'abc',
    base: null,
    candidate: null,
    artifacts: [],
    operations: [],
    attemptLimit: null,
  };
  const retro = { ...job, artifacts: [ISSUES_FILE] };
  const triage = [
    { title: 'Fix', body: 'b', link: null, start: 'plan', elevated: false, priority: 'P2' },
  ] as const;
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
    issue: { number: 1, title: 'T', revision: '' },
  } as Job;
  const issue = { number: 1, html_url: '', node_id: '', title: 'T', body: '', labels: [] };
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
    assert.match(writes[0]!, /^POST \/repos\/gingur-root\/scratch\/issues .*"labels":\["retro"\]/);
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
