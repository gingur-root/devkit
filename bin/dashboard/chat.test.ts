// Phone and desk share one conversation per thread, and the coordinator must
// see each new issue comment once: a lost session or a re-sent comment would
// fail quietly, so both are pinned here.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vite-plus/test';

import { chatTurn } from './chat.ts';
import type { CoordinatorEvent } from './coordinator.ts';
import type { ThreadView } from './issue.ts';
import { createStore } from './store.ts';

const ref = { repo: 'devkit', number: 7 };
const comment = (id: number) => ({
  id,
  author: 'gingur-root-pipeline[bot]',
  body: `comment ${id}`,
  at: '2026-10-14T00:00:00Z',
});

function fake(comments: ReturnType<typeof comment>[]) {
  const prompts: { prompt: string; resume?: string }[] = [];
  async function* run(prompt: string, resume?: string): AsyncGenerator<CoordinatorEvent> {
    prompts.push({ prompt, resume });
    yield { type: 'session', id: 's1' };
    yield { type: 'text', text: 'ok' };
    yield { type: 'done', ok: true };
  }
  const read = async () => ({ comments }) as unknown as ThreadView;
  return { prompts, run, read };
}

async function drain(turn: AsyncGenerator<CoordinatorEvent>) {
  for await (const _ of turn);
}

test('an issue turn resumes its session and passes each new comment once', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'dash-')), 'state.json');
  const first = fake([comment(1), comment(2)]);
  await drain(chatTurn(createStore(file), 'hi', ref, first.run, first.read));
  assert.equal(first.prompts[0]?.resume, undefined);
  assert.match(
    first.prompts[0]!.prompt,
    /thread for gingur-root\/devkit#7[\s\S]*comment 1[\s\S]*comment 2[\s\S]*Troy now says:\nhi$/,
  );

  // A fresh store on the same file stands in for the other device.
  const second = fake([comment(1), comment(2), comment(3)]);
  await drain(chatTurn(createStore(file), 'next', ref, second.run, second.read));
  assert.equal(second.prompts[0]?.resume, 's1');
  assert.doesNotMatch(second.prompts[0]!.prompt, /comment 2|thread for/);
  assert.match(second.prompts[0]!.prompt, /comment 3/);

  const lines = (await createStore(file).get('devkit#7')).lines.map((l) => `${l.role}:${l.text}`);
  assert.deepEqual(lines, ['me:hi', 'bot:ok', 'me:next', 'bot:ok']);
});

test('a home turn with nothing new sends the prompt as typed', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'dash-')), 'state.json');
  const home = fake([]);
  await drain(chatTurn(createStore(file), 'file a bug', undefined, home.run, home.read));
  assert.equal(home.prompts[0]?.prompt, 'file a bug');
});
