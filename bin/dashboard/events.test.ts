// A missed change leaves the page stale with no error, and a poll that never
// stops or overlaps burns the GitHub rate limit quietly.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi } from 'vite-plus/test';

import type { Status } from '../agent/constants.ts';
import { BOARD_EVENT } from './constants.ts';
import { diffBoard, POLL_MS, pollBoard, snapshot } from './events.ts';

const card = (number: number, updatedAt = 't1', column: Status = 'Ask') => ({
  repo: 'devkit',
  number,
  updatedAt,
  column,
});

test('a changed card, a new or removed card, and nothing when nothing changed', () => {
  const before = snapshot([card(1), card(2)]);
  assert.deepEqual(diffBoard(before, snapshot([card(1), card(2)])), []);
  assert.deepEqual(diffBoard(before, snapshot([card(1, 't2'), card(2)])), [
    { type: BOARD_EVENT.cardChanged, repo: 'devkit', number: 1 },
  ]);
  assert.deepEqual(diffBoard(before, snapshot([card(1), card(2, 't1', 'Ready')])), [
    { type: BOARD_EVENT.cardChanged, repo: 'devkit', number: 2 },
  ]);
  assert.deepEqual(diffBoard(before, snapshot([card(1)])), [{ type: BOARD_EVENT.boardChanged }]);
  assert.deepEqual(diffBoard(before, snapshot([card(1), card(2), card(3)])), [
    { type: BOARD_EVENT.boardChanged },
  ]);
  // Same count, different cards.
  assert.deepEqual(diffBoard(before, snapshot([card(1), card(3)])), [
    { type: BOARD_EVENT.boardChanged },
  ]);
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

test('polls only while someone listens, and emits what changed', async () => {
  let updatedAt = 't1';
  const read = vi.fn(async () => [card(1, updatedAt)]);
  const source = pollBoard(read);
  await vi.advanceTimersByTimeAsync(POLL_MS * 3);
  assert.equal(read.mock.calls.length, 0);

  const heard: unknown[] = [];
  const stopA = source.subscribe((e) => heard.push(e));
  const stopB = source.subscribe(() => {});
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(read.mock.calls.length, 1);
  updatedAt = 't2';
  await vi.advanceTimersByTimeAsync(POLL_MS);
  assert.equal(read.mock.calls.length, 2);
  assert.deepEqual(heard, [{ type: BOARD_EVENT.cardChanged, repo: 'devkit', number: 1 }]);

  stopA();
  await vi.advanceTimersByTimeAsync(POLL_MS);
  assert.equal(read.mock.calls.length, 3);
  stopB();
  await vi.advanceTimersByTimeAsync(POLL_MS * 3);
  assert.equal(read.mock.calls.length, 3);
});

test('never starts a read while one is running, nor after the last listener left', async () => {
  let inFlight = 0;
  let most = 0;
  let finish = () => {};
  const read = vi.fn(async () => {
    most = Math.max(most, ++inFlight);
    await new Promise<void>((resolve) => (finish = resolve));
    inFlight--;
    return [card(1)];
  });
  const source = pollBoard(read);
  // Leave and come back while the first read hangs.
  source.subscribe(() => {})();
  const stop = source.subscribe(() => {});
  await vi.advanceTimersByTimeAsync(POLL_MS * 3);
  assert.equal(read.mock.calls.length, 1);
  finish();
  await vi.advanceTimersByTimeAsync(POLL_MS);
  assert.equal(read.mock.calls.length, 2);
  // The last listener leaves mid-read: that read must not schedule another.
  stop();
  finish();
  await vi.advanceTimersByTimeAsync(POLL_MS * 3);
  assert.equal(read.mock.calls.length, 2);
  assert.equal(most, 1);
});
