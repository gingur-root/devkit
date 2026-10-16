// The result schema is the one gate between an agent's output and a published
// comment; a loosened schema would pass a bad result silently.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vite-plus/test';

import { Result } from './result.ts';

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
