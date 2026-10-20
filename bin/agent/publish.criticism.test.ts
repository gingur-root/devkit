import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished, test, vi } from 'vite-plus/test';

import { setStatus } from './board.ts';
import { OPERATOR_ID, PIPELINE_BOT } from './constants.ts';
import { CONTRACT_PREFIX, Job, planRevision, revision } from './job.ts';
import { planComment, publish } from './publish.ts';
import { approvedPlan } from './render.ts';
import { Result } from './result.ts';

vi.mock('./board.ts', () => ({ setStatus: vi.fn(), proposePriority: vi.fn() }));

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'criticism-publish-'));
  const input = join(root, 'in'),
    output = join(root, 'out'),
    critic = join(root, 'critic');
  for (const dir of [input, output, join(critic, 'in'), join(critic, 'out')])
    mkdirSync(dir, { recursive: true });
  const issue = { number: 1, node_id: 'issue', title: 'Title', body: 'Body', labels: [] };
  const job = Job.parse({
    job: 'plan-1',
    role: 'plan',
    objective: '',
    repo: 'o/r',
    issue: {
      number: 1,
      title: issue.title,
      revision: revision(issue.title, issue.body),
      bodySeen: true,
    },
    plan: null,
    source: 'base123456',
    base: null,
    candidate: null,
    artifacts: [],
    operations: [],
    attemptLimit: null,
  });
  const result = Result.parse(
    JSON.parse(readFileSync(new URL('fixtures/plan.ready.json', import.meta.url), 'utf8')),
  );
  Object.assign(result, { job: job.job, critique: true });
  result.inputs.issue = job.issue.revision;
  writeFileSync(join(input, 'job.json'), JSON.stringify(job));
  writeFileSync(join(output, 'result.json'), JSON.stringify(result));
  writeFileSync(join(output, 'plan.md'), 'plan');
  const criticJob = Job.parse({
    ...job,
    role: 'critique',
    plan: { revision: planRevision('plan'), criteria: ['A1'], checks: { A1: 'agent' } },
  });
  writeFileSync(join(critic, 'in/job.json'), JSON.stringify(criticJob));
  const criticResult = Result.parse({
    ...result,
    role: 'critique',
    outcome: 'pass',
    critique: null,
    priority: null,
    inputs: { ...result.inputs, plan: criticJob.plan!.revision, base: job.source },
  });
  const original = planComment(job, result, output, null, []);
  const comments = [
    {
      id: 10,
      body: original,
      user: { id: PIPELINE_BOT.id, type: 'Bot' },
      performed_via_github_app: { id: 7 },
      created_at: '2026-01-01T00:00:00Z',
    },
    {
      id: 11,
      body: '<!-- devkit:continue -->',
      user: { id: PIPELINE_BOT.id, type: 'Bot' },
      performed_via_github_app: { id: 7 },
      created_at: '2026-01-01T00:00:01Z',
    },
  ];
  const writes: { method: string; path: string; body: { body?: string; labels?: string[] } }[] = [];
  vi.stubEnv('GH_TOKEN', 'test');
  vi.stubEnv('DEVKIT_APP_ONLY', '1');
  const githubOutput = join(root, 'github-output');
  writeFileSync(githubOutput, '');
  vi.stubEnv('GITHUB_OUTPUT', githubOutput);
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (init.method !== 'GET') writes.push({ method: init.method!, path, body });
    if (path === '/repos/o/r/issues/1') return Response.json(issue);
    if (init.method === 'GET' && path.endsWith('/comments')) return Response.json(comments);
    if (path.endsWith('/events'))
      return Response.json([
        {
          event: 'labeled',
          label: { name: 'agent:plan' },
          actor: { id: PIPELINE_BOT.id },
          created_at: '2026-01-01T00:00:02Z',
        },
      ]);
    if (path.endsWith('/reactions')) return Response.json([]);
    if (init.method === 'PATCH') {
      comments[0]!.body = body.body;
      return Response.json(comments[0]);
    }
    return Response.json({ id: 12, body: body.body });
  });
  const exit = process.exitCode;
  onTestFinished(() => {
    process.exitCode = exit;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    rmSync(root, { recursive: true, force: true });
  });
  function criticOutcome(outcome: string | null) {
    if (outcome !== null)
      writeFileSync(join(critic, 'out/result.json'), JSON.stringify({ ...criticResult, outcome }));
  }
  return {
    job,
    input,
    output,
    critic,
    criticJob,
    criticResult,
    criticOutcome,
    comments,
    original,
    writes,
    githubOutput,
  };
}

for (const outcome of ['pass', 'changes-requested', null]) {
  test(`plan publication records ${outcome ?? 'missing'} criticism and only a pass hands off`, async () => {
    const h = harness();
    h.criticOutcome(outcome);
    await publish({ in: h.input, out: h.output, critique: h.critic });
    const body = h.writes.find((write) => write.method === 'PATCH')!.body.body!;
    assert.match(body, /## Criticism/);
    const contract = approvedPlan(
      [{ body, user: { id: OPERATOR_ID }, created_at: '' }],
      7,
      h.job.issue.revision,
      true,
    ).contract;
    assert.deepEqual(contract.criticism, {
      outcome: outcome ?? 'failed',
      planRevision: h.criticJob.plan!.revision,
      issueRevision: h.job.issue.revision,
      source: h.job.source,
    });
    assert.equal(
      h.writes.some((write) => write.body.labels?.includes('agent:build')),
      outcome === 'pass',
    );
    if (outcome !== 'pass') assert.match(body, /criticism did not pass/);
    assert.equal(process.exitCode === 1, outcome === null);
  });
}

for (const outcome of ['pass', 'changes-requested', 'inconclusive', null]) {
  test(`build criticism ${outcome ?? 'missing'} updates only the contract and stops visibly when needed`, async () => {
    const h = harness();
    h.criticOutcome(outcome);
    await publish({ in: join(h.critic, 'in'), out: join(h.critic, 'out'), appId: 7 });
    const edited = h.comments[0]!.body;
    const without = (body: string) =>
      body
        .split('\n')
        .filter((line) => !line.startsWith(CONTRACT_PREFIX))
        .join('\n');
    assert.equal(without(edited), without(h.original));
    const contract = approvedPlan(h.comments, 7, h.job.issue.revision, true).contract;
    assert.equal(contract.criticism?.outcome, outcome ?? 'failed');
    assert.equal(readFileSync(h.githubOutput, 'utf8'), `pass=${outcome === 'pass'}\n`);
    assert.equal(process.exitCode === 1, outcome === null);
    if (outcome !== 'pass') {
      assert.ok(
        h.writes.some((w) =>
          w.body.body?.includes(
            `Build blocked: criticism ${outcome ?? 'failed'} on plan ${h.criticJob.plan!.revision.slice(0, 7)} at ${h.job.source.slice(0, 7)}`,
          ),
        ),
      );
      assert.ok(
        h.writes.some(
          (w) =>
            w.method === 'DELETE' && decodeURIComponent(w.path).endsWith('/labels/agent:build'),
        ),
      );
      assert.ok(vi.mocked(setStatus).mock.calls.some((call) => call[2] === 'Needs you'));
    }
  });
}

test('a critic result cannot change its controller-rendered source or grant a stale pass', async () => {
  const h = harness();
  writeFileSync(
    join(h.critic, 'out/result.json'),
    JSON.stringify({ ...h.criticResult, inputs: { ...h.criticResult.inputs, base: 'invented' } }),
  );
  await publish({ in: join(h.critic, 'in'), out: join(h.critic, 'out'), appId: 7 });
  assert.equal(readFileSync(h.githubOutput, 'utf8'), 'pass=false\n');
  assert.equal(process.exitCode, 1);
});

test('invalid criticism and a changed plan cannot grant a build pass', async () => {
  const h = harness();
  writeFileSync(join(h.critic, 'out/result.json'), '{}');
  await publish({ in: join(h.critic, 'in'), out: join(h.critic, 'out'), appId: 7 });
  assert.equal(process.exitCode, 1);
  assert.equal(readFileSync(h.githubOutput, 'utf8'), 'pass=false\n');
  process.exitCode = 0;
  h.criticOutcome('pass');
  h.comments[0]!.body = h.original.replace('\nplan\n', '\nchanged plan\n');
  writeFileSync(h.githubOutput, '');
  await publish({ in: join(h.critic, 'in'), out: join(h.critic, 'out'), appId: 7 });
  assert.equal(process.exitCode, 1);
  assert.equal(readFileSync(h.githubOutput, 'utf8'), 'pass=false\n');
});

test('contract-only replacement preserves CRLF and literal replacement tokens in plan text', async () => {
  const h = harness();
  h.criticOutcome('pass');
  h.comments[0]!.body = h.original.replaceAll('\n', '\r\n') + '\r\nOperator note: $&';
  const original = h.comments[0]!.body;
  await publish({ in: join(h.critic, 'in'), out: join(h.critic, 'out'), appId: 7 });
  const strip = (body: string) => body.replace(/^<!-- devkit:contract [^\r\n]* -->/m, 'contract');
  assert.equal(strip(h.comments[0]!.body), strip(original));
  assert.equal(readFileSync(h.githubOutput, 'utf8'), 'pass=true\n');
});
