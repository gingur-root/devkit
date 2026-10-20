import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vite-plus/test';
import { chain } from './chain.ts';
import { Job, planRevision } from './job.ts';
import { ROLES } from './roles.ts';

const fixture = JSON.parse(
  readFileSync(new URL('fixtures/plan.ready.json', import.meta.url), 'utf8'),
);

test('chain preserves trusted input and copies only plan artifacts from agent output', () => {
  const root = mkdtempSync(join(tmpdir(), 'chain-'));
  const input = join(root, 'in'),
    output = join(root, 'agent-out'),
    out = join(root, 'next');
  mkdirSync(input);
  mkdirSync(output);
  const job = Job.parse({
    job: 'plan-1',
    role: 'plan',
    objective: '',
    repo: 'o/r',
    issue: { number: 1, title: 'T', revision: 'issue', bodySeen: true },
    source: 'base',
    base: null,
    candidate: null,
    plan: null,
    artifacts: [],
    operations: [],
    attemptLimit: null,
  });
  writeFileSync(join(input, 'job.json'), JSON.stringify(job));
  writeFileSync(join(input, 'issue.md'), 'trusted issue');
  writeFileSync(join(input, 'tools.json'), 'trusted tools');
  mkdirSync(join(input, 'overrides'));
  writeFileSync(join(input, 'overrides/critic.md'), 'trusted critic');
  writeFileSync(join(output, 'tools.json'), 'untrusted tools');
  writeFileSync(join(output, 'job.json'), '{}');
  writeFileSync(join(output, 'result.json'), JSON.stringify(fixture));
  writeFileSync(join(output, 'plan.md'), '  plan\r\n');
  writeFileSync(join(output, 'research.md'), 'research');
  writeFileSync(join(output, 'probe.json'), '{"probe":true}');
  try {
    chain({ role: 'critique', fromIn: input, fromOut: output, out });
    const next = Job.parse(JSON.parse(readFileSync(join(out, 'job.json'), 'utf8')));
    assert.equal(next.role, 'critique');
    assert.equal(next.objective, ROLES.critique.objective);
    assert.equal(next.plan?.revision, planRevision('plan'));
    assert.deepEqual(next.plan?.checks, { A1: 'agent' });
    assert.deepEqual(next.plan?.criteria, ['A1']);
    assert.equal(next.source, 'base');
    for (const [path, text] of [
      ['tools.json', 'trusted tools'],
      ['issue.md', 'trusted issue'],
      ['overrides/critic.md', 'trusted critic'],
      ['research.md', 'research'],
      ['probe.json', '{"probe":true}'],
    ])
      assert.equal(readFileSync(join(out, path!), 'utf8'), text);
    chain({ role: 'critique', fromIn: out, out: join(root, 'again') });
    assert.deepEqual(
      JSON.parse(readFileSync(join(root, 'again/job.json'), 'utf8')).plan,
      next.plan,
    );
    rmSync(join(output, 'plan.md'));
    assert.throws(
      () => chain({ role: 'critique', fromIn: input, fromOut: output, out: join(root, 'missing') }),
      /plan.md/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
