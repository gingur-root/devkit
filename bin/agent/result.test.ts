// The result schema is the one gate between an agent's output and a published
// comment; a loosened schema would pass a bad result silently.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'vite-plus/test';

import { Result, RESULT_JSON_SCHEMA } from './result.ts';

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`fixtures/${name}.json`, import.meta.url), 'utf8'));

test('only a complete, strict result envelope validates', () => {
  const ready = fixture('plan.ready');
  assert.ok(Result.safeParse(ready).success);
  assert.ok(!Result.safeParse(fixture('plan.invalid')).success);
  assert.ok(!Result.safeParse({ ...ready, extra: true }).success, 'unknown fields are rejected');
  assert.ok(!Result.safeParse({ ...ready, criteria: undefined }).success, 'null, never absent');
  const long = Result.parse({ ...ready, summary: 'word '.repeat(163) });
  assert.equal(long.summary.split(' ').length, 151, 'a long summary is clipped to 150 words and …');
});

test('a subtask must declare blockedBy, including null when it has none', () => {
  const story = fixture('plan.story');
  assert.ok(Result.safeParse(story).success);
  delete story.subtasks[0].blockedBy;
  assert.equal(Result.safeParse(story).success, false);
});

test('a plan accepts operator criteria and rejects unknown check kinds', () => {
  const ready = fixture('plan.ready');
  const criterion = { id: 'A1', text: 'Troy verifies the live result', check: 'operator' };
  const parsed = Result.parse({ ...ready, criteria: [criterion] });
  assert.deepEqual(parsed.criteria, [criterion]);
  assert.ok(!Result.safeParse({ ...ready, criteria: [{ ...criterion, check: 'manual' }] }).success);
});

test('every role may return follow-ups, and each subtask says whether it needs the desk', () => {
  const required = RESULT_JSON_SCHEMA.required as string[];
  assert.ok(required.includes('followups') && required.includes('subtasks'));
  const valid = readdirSync(new URL('fixtures/', import.meta.url)).filter(
    (f) => f.endsWith('.json') && !f.endsWith('.invalid.json'),
  );
  assert.ok(valid.includes('plan.story.json') && valid.includes('build.followups.json'));
  for (const file of valid) {
    const parsed = Result.safeParse(fixture(file.replace(/\.json$/, '')));
    assert.ok(parsed.success, `${file}: ${parsed.error?.message}`);
  }
});
