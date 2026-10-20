// A role's skills come from devkit and the job's trusted override snapshot;
// a wrong match silently changes what an agent is told.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, vi } from 'vite-plus/test';

import type { Job } from './job.ts';
import { PROVIDERS } from './providers/index.ts';
import { Result } from './result.ts';
import { ROLES } from './roles.ts';
import { failedResult, instructions, resolveRole, run, settle, skillRoles } from './run.ts';

test('credential selection uses the effective executor, including role defaults and overrides', () => {
  assert.equal(resolveRole({ role: 'build' }).executor, 'codex');
  assert.equal(resolveRole({ role: 'plan' }).executor, 'claude');
  assert.equal(resolveRole({ role: 'build', executor: 'claude' }).executor, 'claude');
  assert.equal(resolveRole({ role: 'plan', executor: 'stub' }).executor, 'stub');
});

function repoSkill(overrides: string, name: string, roles: string, body: string): void {
  mkdirSync(join(overrides, 'skills', name), { recursive: true });
  writeFileSync(
    join(overrides, 'skills', name, 'SKILL.md'),
    `---\nname: ${name}\nroles: ${roles}\n---\n\n${body}\n`,
  );
}

test('a role gets the skills that name it; the repo adds and replaces them', () => {
  const overrides = mkdtempSync(join(tmpdir(), 'devkit-skills-'));
  try {
    assert.match(instructions('plan', ROLES.plan, overrides), /# Plain English/);
    assert.doesNotMatch(instructions('hello', ROLES.hello, overrides), /# Plain English/);
    // Only roles that write docs or instructions get Simple English.
    assert.match(instructions('build', ROLES.build, overrides), /# Simple English/);
    assert.doesNotMatch(instructions('review', ROLES.review, overrides), /# Simple English/);
    for (const role of ['plan', 'build', 'repair', 'review', 'replan', 'retro'] as const)
      assert.match(instructions(role, ROLES[role], overrides), /# Plain English/);
    for (const role of ['build', 'repair'] as const)
      assert.match(instructions(role, ROLES[role], overrides), /# Simple English/);

    repoSkill(overrides, 'infra', 'build', 'INFRA SKILL');
    assert.match(instructions('build', ROLES.build, overrides), /INFRA SKILL/);
    assert.doesNotMatch(instructions('plan', ROLES.plan, overrides), /INFRA SKILL/);

    repoSkill(overrides, 'plain-english', 'plan', 'REPO PLAIN');
    assert.match(instructions('plan', ROLES.plan, overrides), /REPO PLAIN/);
    assert.doesNotMatch(instructions('plan', ROLES.plan, overrides), /# Plain English/);
    assert.doesNotMatch(instructions('build', ROLES.build, overrides), /Plain English|REPO PLAIN/);
  } finally {
    rmSync(overrides, { recursive: true, force: true });
  }
});

test('run uses trusted job overrides and ignores candidate instructions and skills in cwd', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'devkit-run-overrides-'));
  const cwd = join(dir, 'candidate');
  const input = join(dir, 'in');
  const out = join(dir, 'out');
  const overrides = join(input, 'overrides');
  mkdirSync(join(cwd, '.devkit/agents'), { recursive: true });
  mkdirSync(join(overrides, 'agents'), { recursive: true });
  mkdirSync(out);
  writeFileSync(join(cwd, '.devkit/agents/review.md'), 'CANDIDATE TEXT');
  writeFileSync(join(overrides, 'agents/contract.md'), 'TRUSTED TEXT');
  repoSkill(join(cwd, '.devkit'), 'plain-english', 'review', 'CANDIDATE SKILL');
  repoSkill(overrides, 'repo', 'review', 'TRUSTED SKILL');
  const provider = vi.spyOn(PROVIDERS, 'stub').mockResolvedValue({ ok: true, result: {} });
  try {
    for (const inDir of [input, undefined]) {
      await run({ role: 'review', executor: 'stub', cwd, in: inDir, out });
      const text = provider.mock.calls.at(-1)![0].instructions;
      assert.doesNotMatch(text, /CANDIDATE TEXT|CANDIDATE SKILL/);
      assert.ok(
        text.includes(
          readFileSync(new URL('../../agents/review.md', import.meta.url), 'utf8').trim(),
        ),
      );
      assert.match(text, /# Plain English/);
      if (inDir) {
        assert.match(text, /TRUSTED TEXT/);
        assert.match(text, /TRUSTED SKILL/);
      } else {
        assert.doesNotMatch(text, /TRUSTED TEXT|TRUSTED SKILL/);
      }
    }
  } finally {
    provider.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every devkit skill's roles are real roles", () => {
  const dir = new URL('../../skills/', import.meta.url);
  for (const name of readdirSync(dir)) {
    const roles = skillRoles(readFileSync(new URL(`${name}/SKILL.md`, dir), 'utf8'));
    for (const role of roles) assert.ok(role in ROLES, `${name} names unknown role ${role}`);
  }
});

test('the envelope written for a run with no result passes the schema publish checks', () => {
  const job: Job = {
    job: 'build-1',
    role: 'build',
    objective: '',
    repo: 'o/r',
    issue: { number: 1, title: 't', revision: 'rev', bodySeen: true },
    plan: { revision: 'plan', criteria: [] },
    source: 'sha',
    base: 'sha',
    candidate: null,
    memory: null,
    artifacts: [],
    operations: [],
    attemptLimit: null,
  };
  const missing = settle({ ok: true }, true);
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'the agent finished without a structured result');
  const absent = Result.parse(failedResult(job, missing));
  assert.equal(absent.status, 'failed');
  assert.equal(absent.failure?.class, 'unknown');
  assert.ok(absent.summary.includes(missing.error));
  const success = { ok: true, result: absent };
  assert.equal(settle(success, true), success);
  const noSchema = { ok: true };
  assert.equal(settle(noSchema, false), noSchema);

  const long = { ok: false, error: 'word '.repeat(400) };
  assert.equal(settle(long, true), long);
  const result = Result.parse(failedResult(job, long));
  assert.equal(result.failure?.class, 'unknown');
  assert.equal(result.inputs.plan, 'plan');
  const limited = failedResult(job, {
    ok: false,
    failure: { class: 'rate_limit', resetsAt: null },
  });
  assert.equal(Result.parse(limited).failure?.class, 'rate_limit');
});
