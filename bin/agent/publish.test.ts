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
  passes,
  publishRetro,
  readyToBuild,
  repairable,
  stopped,
  verdict,
} from './publish.ts';
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
