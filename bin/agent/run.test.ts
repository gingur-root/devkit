// A role's skills come from devkit and the target repo's `.devkit/skills/`;
// a wrong match silently changes what an agent is told.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vite-plus/test';

import type { Job } from './job.ts';
import { Result } from './result.ts';
import { ROLES } from './roles.ts';
import { failedResult, instructions, settle, skillRoles } from './run.ts';

function repoSkill(cwd: string, name: string, roles: string, body: string): void {
  mkdirSync(join(cwd, '.devkit', 'skills', name), { recursive: true });
  writeFileSync(
    join(cwd, '.devkit', 'skills', name, 'SKILL.md'),
    `---\nname: ${name}\nroles: ${roles}\n---\n\n${body}\n`,
  );
}

test('a role gets the skills that name it; the repo adds and replaces them', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'devkit-skills-'));
  assert.match(instructions('plan', ROLES.plan, cwd), /# Plain English/);
  assert.doesNotMatch(instructions('hello', ROLES.hello, cwd), /# Plain English/);
  // Only roles that write docs or instructions get Simple English.
  assert.match(instructions('build', ROLES.build, cwd), /# Simple English/);
  assert.doesNotMatch(instructions('review', ROLES.review, cwd), /# Simple English/);

  repoSkill(cwd, 'infra', 'elevated', 'INFRA SKILL');
  assert.match(instructions('elevated', ROLES.elevated, cwd), /INFRA SKILL/);
  assert.doesNotMatch(instructions('plan', ROLES.plan, cwd), /INFRA SKILL/);

  repoSkill(cwd, 'plain-english', 'plan', 'REPO PLAIN');
  assert.match(instructions('plan', ROLES.plan, cwd), /REPO PLAIN/);
  assert.doesNotMatch(instructions('plan', ROLES.plan, cwd), /# Plain English/);
  assert.doesNotMatch(instructions('build', ROLES.build, cwd), /Plain English|REPO PLAIN/);
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
    issue: { number: 1, title: 't', revision: 'rev' },
    plan: { revision: 'plan', criteria: [] },
    source: 'sha',
    base: 'sha',
    candidate: null,
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
