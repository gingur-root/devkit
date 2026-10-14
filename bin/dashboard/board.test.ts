// A story's column is derived, so a wrong rule would quietly show it in the wrong place.
import assert from 'node:assert/strict';
import { test } from 'vite-plus/test';

import type { Status } from '../agent/constants.ts';
import { cardColumn } from './board.ts';

const open = (status: Status | null) => ({ open: true, status });
const closed = { open: false, status: 'Done' as const };
const story = (...subtasks: { open: boolean; status: Status | null }[]) => ({
  open: true,
  status: 'Ask' as const,
  subtasks,
});

test('a story sits with its least-advanced open subtask', () => {
  assert.equal(cardColumn(story(open('Ready'), open('Building'), open('Planning'))), 'Planning');
  // Not on the board yet reads as Ask.
  assert.equal(cardColumn(story(open('Building'), open(null))), 'Ask');
});

test('any open subtask in Needs you puts the story there', () => {
  assert.equal(cardColumn(story(open('Planning'), open('Needs you'))), 'Needs you');
});

test('a story is Done only when every subtask is', () => {
  assert.equal(cardColumn(story(closed, open('Done'))), 'Done');
  assert.equal(cardColumn(story(closed, open('Ready'))), 'Ready');
});

test('closed subtasks are ignored, whatever column they were left in', () => {
  assert.equal(
    cardColumn(story({ open: false, status: 'Needs you' }, open('Building'))),
    'Building',
  );
});

test('a story not on the board still takes its column from its subtasks', () => {
  assert.equal(cardColumn({ ...story(open('Ready')), status: null }), 'Ready');
});

test('a plain card keeps its own column; closed is Done', () => {
  assert.equal(cardColumn({ ...open('Building'), subtasks: [] }), 'Building');
  assert.equal(cardColumn({ ...open(null), subtasks: [] }), 'Ask');
  assert.equal(cardColumn({ open: false, status: 'Ready', subtasks: [open('Ask')] }), 'Done');
});
