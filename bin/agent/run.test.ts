// A role's skills come from devkit and the target repo's `.devkit/skills/`;
// a wrong match silently changes what an agent is told.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vite-plus/test';

import { ROLES } from './roles.ts';
import { instructions, skillRoles } from './run.ts';

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
