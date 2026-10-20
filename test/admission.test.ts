// Locks the admission gate: the one expression that keeps everyone but the
// owner off every credential-holding job. devkit is public and a loosened gate
// fails silently, so its text is pinned twice (here and in
// .github/admission.txt), and every job must carry it or run only after a job
// that did.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'vite-plus/test';
import { parse } from 'yaml';

import { REPAIR_ROUNDS } from '../bin/agent/constants.ts';

const ADMISSION =
  "github.repository_owner_id == '340382989' && github.run_attempt == '1' && " +
  "((github.actor_id == '2553213' && (github.event_name == 'workflow_dispatch' || " +
  '(github.event_name == \'issues\' && github.event.action == \'labeled\' && contains(fromJSON(\'["agent:plan","agent:build","agent:research","ready-for-agent"]\'), github.event.label.name)) || ' +
  "(github.event_name == 'issue_comment' && github.event.action == 'created' && (startsWith(github.event.comment.body, '/plan') || startsWith(github.event.comment.body, '/revise') || " +
  "startsWith(github.event.comment.body, '/approve'))))) || " +
  // The pipeline App's bot may add only stage labels: `agent:plan` for the board loop (devkit#47),
  // and `agent:build` for a plan's hand-off after a dashboard Continue, which render then checks (bin/agent/approval.ts, devkit#99).
  "(github.actor_id == '340770692' && github.event_name == 'issues' && github.event.action == 'labeled' && " +
  'contains(fromJSON(\'["agent:plan","agent:build"]\'), github.event.label.name)) || ' +
  // The org webhook receiver dispatches every stage in the central caller (devkit#118); it applies
  // the rule above to the event's sender first (bin/webhooks/pipeline.ts).
  "(github.repository == 'gingur-root/pipeline' && github.actor_id == '340770692' && github.event_name == 'workflow_dispatch'))";

const root = new URL('../', import.meta.url);
const workflows = new URL('.github/workflows/', root);

test('build runs have one repair job per configured repair round', () => {
  const workflow = parse(readFileSync(new URL('agent.build.yml', workflows), 'utf8')) as {
    jobs: Record<string, unknown>;
  };
  const repairs = Object.keys(workflow.jobs).filter((id) => /^repair-\d+$/.test(id));
  assert.equal(REPAIR_ROUNDS, 10);
  assert.equal(repairs.length, 10);
});

test('every round passes the cap and base, chains repair or rerun, and reaches finalization', () => {
  const { jobs, on } = parse(readFileSync(new URL('agent.build.yml', workflows), 'utf8'));
  assert.equal(on.workflow_call.inputs.rounds.default, 10);
  const rounds = ['review', ...Array.from({ length: 10 }, (_, i) => `repair-${i + 1}`)];
  for (const [round, id] of rounds.entries()) {
    const job = jobs[id];
    assert.equal(job.uses, './.github/workflows/agent.round.yml');
    assert.equal(job.with.round, round);
    assert.equal(job.with.rounds, '${{ inputs.rounds }}');
    assert.equal(job.with.base, '${{ needs.start.outputs.base }}');
    if (round === 0) assert.deepEqual(job.needs, ['start', 'publish']);
    else {
      const previous = rounds[round - 1];
      assert.deepEqual(job.needs, ['start', previous]);
      assert.equal(
        job.if,
        `\${{ !cancelled() && needs.start.result == 'success' && ((needs.${previous}.result == 'success' && contains(fromJSON('["repair","rerun"]'), needs.${previous}.outputs.next)) || needs.start.outputs.resume == '${round}') }}`,
      );
      assert.equal(
        job.with.candidate,
        `\${{ needs.${previous}.outputs.candidate || needs.start.outputs.candidate }}`,
      );
      assert.equal(job.with.readToken, `\${{ needs.${previous}.outputs.readToken }}`);
      assert.equal(
        job.with.rerun,
        `\${{ needs.${previous}.outputs.next == 'rerun' || needs.start.outputs.resume == '${round}' }}`,
      );
    }
  }
  assert.deepEqual(jobs.retro.needs, [
    'start',
    'critique',
    'criticism',
    'build',
    'publish',
    ...rounds,
  ]);
  assert.deepEqual(jobs.next.needs, [...jobs.retro.needs, 'retro']);
  assert.ok(jobs.retro.if.includes("contains(needs.*.outputs.retro, 'true')"));
});

test('a rerun skips repair and publish but prepares the input candidate for review', () => {
  const { jobs, on } = parse(readFileSync(new URL('agent.round.yml', workflows), 'utf8'));
  assert.equal(on.workflow_call.inputs.rerun.default, false);
  assert.ok(
    jobs.repair.if.endsWith(
      "&& inputs.round > 0 && !inputs.rerun && needs.gate.outputs.next == 'repair'",
    ),
  );
  assert.ok(admits(jobs.push.if));
  assert.ok(
    jobs.push.if.endsWith(
      "&& inputs.round > 0 && (needs.repair.result != 'skipped' || inputs.rerun) }}",
    ),
  );
  assert.equal(
    jobs.push.outputs.candidate,
    '${{ inputs.rerun && inputs.candidate || steps.publish.outputs.candidate }}',
  );
  for (const step of jobs.push.steps.filter(
    (s: { uses?: string; id?: string }) =>
      s.uses?.startsWith('actions/download-artifact@') || s.id === 'publish',
  ))
    assert.equal(step.if, '${{ !inputs.rerun }}');
  const render = jobs.push.steps.find(
    (s: { name?: string }) => s.name === 'Render review and verifier',
  );
  assert.equal(render.env.BASE, '${{ inputs.base }}');
  assert.equal(
    render.env.CANDIDATE,
    '${{ inputs.rerun && inputs.candidate || steps.publish.outputs.candidate }}',
  );
  const pack = jobs.push.steps.find((s: { uses?: string }) =>
    s.uses?.includes('/actions/repo.pack@'),
  );
  assert.equal(pack.with.ref, jobs.push.outputs.candidate);
  for (const id of ['push', 'verdict']) {
    const publish = jobs[id].steps.find((s: { id?: string }) => s.id === 'publish');
    assert.equal(publish.env.ROUNDS, '${{ inputs.rounds }}');
    assert.ok(publish.run.includes('--rounds "$ROUNDS"'));
  }
  assert.equal(jobs.verdict.outputs.next, '${{ steps.publish.outputs.next }}');
  assert.equal(
    jobs.verdict.outputs.candidate,
    '${{ steps.next.outputs.candidate || steps.publish.outputs.head }}',
  );
});

// Splits on an operator at paren depth 0, outside string literals.
function topLevel(expr: string, op: '&&' | '||'): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === "'") quoted = !quoted;
    else if (quoted) continue;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && expr.startsWith(op, i)) {
      parts.push(expr.slice(start, i).trim());
      start = i + op.length;
      i += op.length - 1;
    }
  }
  parts.push(expr.slice(start).trim());
  return parts;
}

// The admission alone, or a top-level `&&` with `(<admission>)` as one operand.
function admits(condition: string): boolean {
  const expr = condition
    .trim()
    .replace(/^\$\{\{([\s\S]*)\}\}$/, '$1')
    .trim();
  if (expr === ADMISSION) return true;
  if (topLevel(expr, '||').length > 1) return false;
  return topLevel(expr, '&&').includes(`(${ADMISSION})`);
}

type Job = { if?: unknown; secrets?: unknown; needs?: string | string[] };

function workflowJobs(): [string, Record<string, Job>][] {
  return readdirSync(workflows)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((file) => [
      file,
      (parse(readFileSync(new URL(file, workflows), 'utf8')) as { jobs?: Record<string, Job> })
        .jobs ?? {},
    ]);
}

test('cancelled runs skip publishing agent output', () => {
  const jobsByWorkflow = new Map(workflowJobs());
  for (const [file, id] of [
    ['agent.build.yml', 'publish'],
    ['agent.plan.yml', 'publish'],
    ['agent.research.yml', 'publish'],
    ['agent.round.yml', 'push'],
    ['agent.round.yml', 'gate'],
  ] as const) {
    const condition = jobsByWorkflow.get(file)?.[id]?.if;
    const where = `${file}#${id}`;
    assert.ok(typeof condition === 'string', `${where} needs a condition`);
    assert.match(condition, /!cancelled\(\)/, where);
    assert.doesNotMatch(condition, /always\(\)/, where);
  }
});

const STATUS_FN = /\b(always|cancelled|failure)\(\)/;

/**
 * A job that can run only once the gate passed: it carries the admission, or it
 * runs after a job that did. With no status function GitHub requires every need
 * to succeed; with one, the condition must name an admitted need's success, or
 * a root's `!= 'skipped'` (a root is skipped only when its gate refuses).
 */
function admitted(jobs: Record<string, Job>, id: string, seen = new Set<string>()): boolean {
  const job = jobs[id];
  if (!job || seen.has(id)) return false;
  seen.add(id);
  const condition = typeof job.if === 'string' ? job.if : '';
  if (condition && admits(condition)) return true;
  const needs = [job.needs ?? []].flat();
  if (!STATUS_FN.test(condition)) return needs.some((n) => admitted(jobs, n, new Set(seen)));
  const clauses = topLevel(condition.replace(/^\$\{\{([\s\S]*)\}\}$/, '$1'), '&&');
  if (topLevel(condition, '||').length > 1) return false;
  return needs.some(
    (n) =>
      (clauses.includes(`needs.${n}.result == 'success'`) && admitted(jobs, n, new Set(seen))) ||
      (clauses.includes(`needs.${n}.result != 'skipped'`) &&
        [jobs[n]?.needs ?? []].flat().length === 0 &&
        typeof jobs[n]?.if === 'string' &&
        admits(jobs[n].if as string)),
  );
}

test('admission.txt holds exactly the pinned expression', () => {
  assert.equal(readFileSync(new URL('.github/admission.txt', root), 'utf8').trim(), ADMISSION);
});

test('the admission check accepts only the allowed forms', () => {
  assert.ok(admits(ADMISSION));
  assert.ok(admits(`\${{ ${ADMISSION} }}`));
  assert.ok(admits(`(${ADMISSION}) && (github.event_name == 'issues')`));
  assert.ok(admits(`always() && (${ADMISSION}) && (github.event_name == 'issues')`));
  assert.ok(!admits(`(${ADMISSION}) || github.actor_id == '1'`));
  assert.ok(!admits(`github.actor_id == '1' || (${ADMISSION}) && true`));
  assert.ok(!admits(`${ADMISSION} && true`), 'admission must be parenthesised when combined');
  assert.ok(!admits(ADMISSION.replace("'2553213'", "'1'")));
  assert.ok(!admits(`(${ADMISSION.replace(" && github.run_attempt == '1'", '')}) && true`));
  assert.ok(!admits("github.actor_id == '2553213'"));
});

test('the chain check accepts only a job that runs after the gate', () => {
  const gate = { if: ADMISSION };
  const yes: Record<string, Job> = {
    start: gate,
    plain: { needs: 'start' },
    deep: { needs: 'plain', if: "needs.plain.outputs.x == 'y'" },
    publish: { needs: ['start', 'plain'], if: "always() && needs.start.result == 'success'" },
    retro: { needs: ['start'], if: "always() && needs.start.result != 'skipped'" },
  };
  for (const id of Object.keys(yes)) assert.ok(admitted(yes, id), id);
  const no: Record<string, Job> = {
    start: gate,
    open: { needs: 'start', if: 'always()' },
    other: { needs: 'start', if: "always() && needs.plain.result == 'success'" },
    or: { needs: 'start', if: "always() && needs.start.result == 'success' || true" },
    deepSkip: { needs: 'open', if: "always() && needs.open.result != 'skipped'" },
    alone: {},
  };
  for (const id of Object.keys(no).slice(1)) assert.ok(!admitted(no, id), id);
});

test('every job that touches a secret, or names the gate, runs only after the gate', () => {
  for (const [file, jobs] of workflowJobs()) {
    for (const [id, job] of Object.entries(jobs)) {
      const text = JSON.stringify(job);
      const gated =
        // Inside an expression only: `secrets.scan.yml` and `secrets.fetch` are names, not secrets.
        /\$\{\{[^}]*\bsecrets\./.test(text) ||
        job.secrets !== undefined ||
        text.includes('repository_owner_id');
      if (gated) assert.ok(admitted(jobs, id), `${file}#${id} can run without the admission gate`);
    }
  }
});

test('every memory job carries admission and report can run after a failure', () => {
  const { jobs } = parse(readFileSync(new URL('agent.memory.yml', workflows), 'utf8'));
  assert.deepEqual(Object.keys(jobs), ['start', 'memory', 'publish', 'report']);
  for (const job of Object.values(jobs) as { if: string; environment: string }[]) {
    assert.ok(admits(job.if));
    assert.equal(job.environment, 'agents');
  }
  assert.match(jobs.report.if, /^always\(\) &&/);
  assert.match(jobs.report.if, /contains\(needs\.\*\.result, 'failure'\)/);
  assert.match(jobs.report.if, /contains\(needs\.\*\.result, 'cancelled'\)/);
  assert.deepEqual(jobs.report.needs, ['start', 'memory', 'publish']);
  assert.ok(!JSON.stringify(jobs).includes('agent.retro.yml'));
});

test('each repair is gated by replan and resume skips the builder', () => {
  const { jobs, on } = parse(readFileSync(new URL('agent.round.yml', workflows), 'utf8'));
  assert.ok(admits(jobs.replan.if));
  assert.ok(admits(jobs.gate.if));
  assert.ok(jobs.replan.if.endsWith('&& inputs.round > 0 && !inputs.rerun'));
  assert.ok(jobs.gate.if.endsWith('&& inputs.round > 0 && !inputs.rerun }}'));
  assert.doesNotMatch(jobs.gate.if, /needs\.replan\.result/);
  assert.equal(jobs.gate.needs, 'replan');
  assert.equal(jobs.repair.needs, 'gate');
  assert.equal(jobs.repair.steps[0].with.readToken, '${{ needs.gate.outputs.readToken }}');
  assert.equal(
    on.workflow_call.outputs.next.value,
    "${{ jobs.verdict.outputs.next || (jobs.gate.outputs.next != 'repair' && jobs.gate.outputs.next || '') }}",
  );
  assert.equal(on.workflow_call.outputs.retro.value, '${{ jobs.verdict.outputs.retro }}');
  assert.ok(!('retro' in jobs.gate.outputs));
  assert.equal(jobs.gate.outputs.candidate, '${{ steps.publish.outputs.head }}');
  assert.equal(
    on.workflow_call.outputs.candidate.value,
    '${{ jobs.verdict.outputs.candidate || jobs.gate.outputs.candidate }}',
  );
  const renderReplan = jobs.verdict.steps.find((s: { id?: string }) => s.id === 'next');
  assert.match(renderReplan.run, /--role replan/);
  assert.match(renderReplan.run, /artifact=replan-/);
  const renderRepair = jobs.gate.steps.find((s: { id?: string }) => s.id === 'next');
  assert.match(renderRepair.run, /--role repair/);
  assert.match(renderRepair.run, /replan\/in\/review.json/);
  const build = parse(readFileSync(new URL('agent.build.yml', workflows), 'utf8')).jobs;
  for (const id of ['build', 'publish'])
    assert.ok(build[id].if.includes("needs.start.outputs.resume == ''"));
  const read = build.start.steps.find((s: { id?: string }) => s.id === 'read');
  assert.ok(read.if.includes("steps.render.outputs.resume == ''"));
  for (const field of ['base', 'resume', 'candidate'])
    assert.equal(build.start.outputs[field], `\${{ steps.render.outputs.${field} }}`);
});

test('criteria verification reuses the review pack and token and feeds every verdict', () => {
  const build = parse(readFileSync(new URL('agent.build.yml', workflows), 'utf8'));
  const round = parse(readFileSync(new URL('agent.round.yml', workflows), 'utf8'));
  const run = round.jobs.criteria.steps[0];
  assert.equal(run.with.role, 'verify');
  assert.equal(run.with.prefix, 'verify-${{ inputs.round }}');
  assert.equal(run.with.pack, round.jobs.verify.with.pack);
  assert.equal(run.with.source, round.jobs.review.steps[0].with.source);
  assert.equal(run.with.readToken, round.jobs.review.steps[0].with.readToken);
  assert.ok(admits(round.jobs.criteria.if));
  assert.ok(round.jobs.criteria.if.includes('(inputs.round == 0 && inputs.criteria)'));
  assert.ok(
    round.jobs.criteria.if.includes("(inputs.round > 0 && needs.push.outputs.criteria == 'true')"),
  );
  assert.equal(round.on.workflow_call.inputs.criteria.default, false);
  assert.equal(build.jobs.review.with.criteria, "${{ needs.publish.outputs.criteria == 'true' }}");
  for (const job of [build.jobs.publish, round.jobs.push]) {
    assert.equal(job.outputs.criteria, '${{ steps.criteria.outputs.criteria }}');
    const render = job.steps.find((s: { id?: string }) => s.id === 'criteria');
    assert.match(render.run, /--role verify --source "\$CANDIDATE"/);
    assert.match(render.run, /plan.checks\).includes\("agent"\)/);
    assert.ok(
      job.steps.some((s: { with?: { name?: string } }) => s.with?.name?.startsWith('verify-')),
    );
  }
  assert.ok(round.jobs.verdict.needs.includes('criteria'));
  const publish = round.jobs.verdict.steps.find((s: { id?: string }) => s.id === 'publish');
  assert.match(
    publish.run,
    /--verifier-in "\$RUNNER_TEMP\/verify\/in" --verifier-out "\$RUNNER_TEMP\/verify\/out"/,
  );
  for (const suffix of ['in', 'out']) {
    const download = round.jobs.verdict.steps.find(
      (s: { with?: { name?: string } }) => s.with?.name === `verify-\${{ inputs.round }}-${suffix}`,
    );
    assert.equal(download['continue-on-error'], true);
    assert.equal(download.with.path, `\${{ runner.temp }}/verify/${suffix}`);
  }
});

test('criticism gates plan handoff and build dispatch at trusted devkit jobs', () => {
  const plan = parse(readFileSync(new URL('agent.plan.yml', workflows), 'utf8')).jobs;
  const build = parse(readFileSync(new URL('agent.build.yml', workflows), 'utf8')).jobs;
  assert.deepEqual(plan.critique.needs, ['start', 'plan']);
  assert.equal(plan.critique.if, "needs.plan.outputs.critique == 'true'");
  assert.deepEqual(plan.publish.needs, ['start', 'plan', 'critique']);
  assert.equal(plan.plan.outputs.critique, '${{ steps.run.outputs.critique }}');
  assert.deepEqual(build.build.needs, ['start', 'criticism']);
  assert.equal(
    build.build.if,
    "${{ !cancelled() && needs.start.result == 'success' && needs.start.outputs.triage != 'true' && needs.start.outputs.resume == '' && (needs.criticism.result == 'skipped' || needs.criticism.outputs.pass == 'true') }}",
  );
  assert.equal(
    build.criticism.if,
    "${{ !cancelled() && needs.start.result == 'success' && needs.start.outputs.critique == 'true' }}",
  );
  assert.equal(
    build.publish.if,
    "${{ !cancelled() && needs.start.result == 'success' && needs.start.outputs.resume == '' && (needs.build.result != 'skipped' || needs.start.outputs.triage == 'true') }}",
  );
  assert.deepEqual(build.criticism.needs, ['start', 'critique']);
  for (const jobs of [plan, build]) {
    assert.ok(jobs.retro.needs.includes('critique'));
    assert.ok(jobs.next.needs.includes('critique'));
    assert.equal(jobs.critique.permissions.contents, 'read');
    const text = JSON.stringify(jobs.critique);
    assert.ok(!text.includes('PIPELINE_SECRETS_TOKEN'));
  }
  for (const job of [plan.critique, build.start, build.criticism]) {
    const checkout = job.steps.find((s: { uses?: string }) =>
      s.uses?.startsWith('actions/checkout@'),
    );
    assert.equal(checkout.with.ref, '${{ inputs.devkitRef }}');
  }
  for (const job of [build.start, build.criticism])
    assert.ok(!JSON.stringify(job).includes('/actions/agent.run@'));
  assert.ok(plan.critique.steps.some((s: { run?: string }) => s.run?.includes('agent chain')));
  assert.ok(build.start.steps.some((s: { run?: string }) => s.run?.includes('agent chain')));
});
