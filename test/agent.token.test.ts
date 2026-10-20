// Locks the agent's read token (devkit#125): agent jobs get only a sealed
// `contents: read` token, never the App key or a write permission. A loosened
// boundary here fails silently.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'vite-plus/test';
import { parse } from 'yaml';

const root = new URL('../', import.meta.url);
const workflows = new URL('.github/workflows/', root);

type Step = {
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
type Job = { permissions?: unknown; steps?: Step[] };

const READ_ROLES = ['plan', 'build', 'review', 'repair'];

function load(url: URL): { jobs?: Record<string, Job>; runs?: { steps?: Step[] } } {
  return parse(readFileSync(url, 'utf8'));
}

function workflowJobs(): [string, Job][] {
  return readdirSync(workflows)
    .filter((f) => /\.ya?ml$/.test(f))
    .flatMap((file) =>
      Object.entries(load(new URL(file, workflows)).jobs ?? {}).map(([id, job]): [string, Job] => [
        `${file}#${id}`,
        job,
      ]),
    );
}

/** Every step in every workflow and composite action, by where it is. */
function allSteps(): [string, Step][] {
  const actions = new URL('actions/', root);
  return [
    ...workflowJobs().flatMap(([where, job]) =>
      (job.steps ?? []).map((step): [string, Step] => [where, step]),
    ),
    ...readdirSync(actions).flatMap((dir) =>
      (load(new URL(`${dir}/action.yml`, actions)).runs?.steps ?? []).map(
        (step): [string, Step] => [`actions/${dir}`, step],
      ),
    ),
  ];
}

const uses = (step: Step, action: string) => step.uses?.includes(`/actions/${action}@`) ?? false;

test('plan, build, review and repair agent jobs read with a sealed token and hold nothing else', () => {
  const seen = new Set<string>();
  for (const [where, job] of workflowJobs()) {
    const run = job.steps?.find((step) => uses(step, 'agent.run'));
    const role = String(run?.with?.role);
    if (!run || !READ_ROLES.includes(role)) continue;
    seen.add(role);
    assert.deepEqual(job.permissions, { contents: 'read' }, where);
    const text = JSON.stringify(job);
    for (const banned of ['PIPELINE_SECRETS_TOKEN', 'app.token', 'agent.token'])
      assert.ok(!text.includes(banned), `${where} references ${banned}`);
    assert.match(
      String(run.with?.readToken ?? ''),
      /^\$\{\{.+\}\}$/,
      `${where} passes no readToken`,
    );
  }
  assert.deepEqual([...seen].sort(), [...READ_ROLES].sort());
});

test('agent.token mints only contents: read, on all repos, unrevoked', () => {
  const steps = load(new URL('actions/agent.token/action.yml', root)).runs?.steps ?? [];
  const mints = steps.filter((step) => uses(step, 'app.token'));
  assert.equal(mints.length, 1);
  assert.deepEqual(mints[0]?.with, {
    appId: '${{ inputs.appId }}',
    token: '${{ inputs.token }}',
    permissionContents: 'read',
    allRepositories: 'true',
    revoke: 'false',
  });
});

test('only sealed agent tokens and memory evidence readers reach all repos', () => {
  for (const [where, step] of allSteps()) {
    if (!uses(step, 'app.token') || where === 'actions/agent.token') continue;
    if (
      ['agent.memory.yml#start', 'agent.memory.yml#publish'].includes(where) &&
      step.id === 'check'
    ) {
      assert.deepEqual(
        step.with,
        {
          appId: '${{ inputs.appId }}',
          token: '${{ secrets.PIPELINE_SECRETS_TOKEN }}',
          allRepositories: 'true',
          permissionContents: 'read',
        },
        where,
      );
    } else assert.ok(!('allRepositories' in (step.with ?? {})), `${where} sets allRepositories`);
    assert.ok(!('revoke' in (step.with ?? {})), `${where} sets revoke`);
  }
});

test('every agent.token call seals with the agents token', () => {
  const calls = allSteps().filter(([, step]) => uses(step, 'agent.token'));
  assert.ok(calls.length > 0);
  for (const [where, step] of calls)
    assert.deepEqual(
      step.with,
      {
        appId: '${{ inputs.appId }}',
        token: '${{ secrets.PIPELINE_SECRETS_TOKEN }}',
        key: '${{ secrets.AGENTS_SECRETS_TOKEN }}',
      },
      where,
    );
});

test('every render uses a separate pipeline-only contents: read token', () => {
  const seen: string[] = [];
  for (const [where, job] of workflowJobs()) {
    const steps = job.steps ?? [];
    const renders = steps.filter((step) => step.run?.includes('agent render'));
    for (const render of renders) {
      seen.push(where);
      const mints = steps.filter((step) => step.id === 'memory');
      assert.equal(mints.length, 1, where);
      const mint = mints[0]!;
      assert.equal(mint.uses, 'gingur-root/devkit/actions/app.token@main', where);
      assert.deepEqual(
        mint.with,
        {
          appId: '${{ inputs.appId }}',
          token: '${{ secrets.PIPELINE_SECRETS_TOKEN }}',
          repositories: 'pipeline',
          permissionContents: 'read',
        },
        where,
      );
      assert.ok(steps.indexOf(mint) < steps.indexOf(render), where);
      assert.equal(mint.if, render.if, where);
      assert.equal(render.env?.MEMORY_TOKEN, '${{ steps.memory.outputs.token }}', where);
    }
    for (const step of steps) {
      if (
        !uses(step, 'app.token') ||
        step.id === 'memory' ||
        (where === 'agent.memory.yml#publish' && step.id === 'app')
      )
        continue;
      assert.ok(
        !String(step.with?.repositories ?? '')
          .split(/[\s,]+/)
          .includes('pipeline'),
        where,
      );
    }
  }
  assert.deepEqual(seen.sort(), [
    'agent.build.yml#publish',
    'agent.build.yml#start',
    'agent.memory.yml#start',
    'agent.plan.yml#start',
    'agent.retro.yml#start',
    'agent.review.yml#push',
    'agent.review.yml#verdict',
  ]);
});

test('memory agent has no GitHub token and the controller alone writes the memory repo', () => {
  const workflow = load(new URL('agent.memory.yml', workflows)).jobs!;
  const agent = workflow.memory!;
  assert.deepEqual(agent.permissions, { contents: 'read' });
  for (const banned of [
    'PIPELINE_SECRETS_TOKEN',
    'app.token',
    'agent.token',
    'readToken',
    'GH_TOKEN',
  ])
    assert.ok(!JSON.stringify(agent).includes(banned), banned);
  const run = agent.steps!.find((step) => uses(step, 'agent.run'))!;
  assert.equal(run.with!.role, 'memory');
  for (const id of ['start', 'publish', 'report']) {
    const checkout = workflow[id]!.steps!.find(
      (step) =>
        step.uses === 'actions/checkout@v6' && step.with?.repository === 'gingur-root/devkit',
    )!;
    assert.equal(checkout.with!.ref, '${{ inputs.devkitRef }}');
  }
  const publish = workflow.publish!.steps!;
  const store = publish.find(
    (step) =>
      step.uses === 'actions/checkout@v6' && step.with?.repository === 'gingur-root/pipeline',
  )!;
  assert.equal(store.with!.ref, '${{ needs.start.outputs.memory }}');
  const token = publish.find((step) => step.id === 'app')!;
  assert.deepEqual(token.with, {
    appId: '${{ inputs.appId }}',
    token: '${{ secrets.PIPELINE_SECRETS_TOKEN }}',
    repositories: 'pipeline',
    permissionContents: 'write',
    permissionPullRequests: 'write',
  });
});
