// The gate's App half (devkit#99): the App may start a build only on a
// dashboard Continue, once. A wrong answer here builds without Troy's say-so.
import assert from 'node:assert/strict';
import { test } from 'vite-plus/test';

import { armedContinue, refuseStart, steps } from './approval.ts';
import { OPERATOR_ID, PIPELINE_BOT } from './constants.ts';
import { marker } from './job.ts';

const APP: number = PIPELINE_BOT.id;
const STRANGER = 1;

const at = (s: number) => `2026-10-14T10:00:${String(s).padStart(2, '0')}Z`;
const comment = (s: number, body: string, id: number = APP) => ({
  created_at: at(s),
  body,
  user: { id },
});
const label = (s: number, name: string, id: number = APP) => ({
  event: 'labeled',
  created_at: at(s),
  actor: { id },
  label: { name },
});

// Continue: its comment, then agent:plan in the same second.
const CONTINUE = [comment(1, `${marker('continue')}\n\nShip it.`)];
const PLAN = [label(1, 'agent:plan')];
const HANDOFF = label(5, 'agent:build');

test('the App may start a build right after a Continue and its plan', () => {
  const history = steps(CONTINUE, [...PLAN, HANDOFF]);
  assert.equal(refuseStart(APP, history, 'build'), null);
});

test('the App may not start a build with no Continue', () => {
  const history = steps([], [label(0, 'agent:plan'), HANDOFF]);
  assert.match(refuseStart(APP, history, 'build') ?? '', /without a dashboard Continue/);
});

test('a Continue starts one build: a second App label is refused', () => {
  const history = steps(CONTINUE, [...PLAN, HANDOFF, label(9, 'agent:build')]);
  assert.notEqual(refuseStart(APP, history, 'build'), null);
});

test('a Continue whose plan asked questions is spent by the next plan', () => {
  const history = steps(CONTINUE, [...PLAN, label(3, 'agent:plan', OPERATOR_ID), HANDOFF]);
  assert.notEqual(refuseStart(APP, history, 'build'), null);
  assert.equal(armedContinue(steps(CONTINUE, [...PLAN, label(3, 'agent:plan')])), null);
});

test('a Continue counts only for the plan it started, within the window', () => {
  const later = (e: ReturnType<typeof label>, time: string) => ({ ...e, created_at: time });
  const plan = later(label(0, 'agent:plan'), '2026-10-14T10:05:00Z');
  assert.equal(armedContinue(steps(CONTINUE, [plan])), null);
  const build = later(HANDOFF, '2026-10-14T10:09:00Z');
  assert.notEqual(refuseStart(APP, steps(CONTINUE, [plan, build]), 'build'), null);
});

test('only an App comment counts as a Continue', () => {
  const forged = [comment(1, `${marker('continue')}\n\nShip it.`, STRANGER)];
  assert.notEqual(refuseStart(APP, steps(forged, [...PLAN, HANDOFF]), 'build'), null);
});

test("the App's own label must come right after the Continue's plan", () => {
  // A later label of the operator's is not this run's.
  const operatorAfter = steps(CONTINUE, [...PLAN, label(5, 'agent:build', OPERATOR_ID)]);
  assert.notEqual(refuseStart(APP, operatorAfter, 'build'), null);
  // The step after a Continue must be a plan, not a build the operator started.
  const approveAfter = steps(CONTINUE, [label(1, 'agent:build', OPERATOR_ID), HANDOFF]);
  assert.notEqual(refuseStart(APP, approveAfter, 'build'), null);
});

test('anyone but the operator and the App is refused, even with a Continue', () => {
  const history = steps(CONTINUE, [...PLAN, label(5, 'agent:build', STRANGER)]);
  assert.match(refuseStart(STRANGER, history, 'build') ?? '', /only the operator/);
});

test('an operator actor input needs the latest start to be his matching stage', () => {
  assert.equal(typeof refuseStart(OPERATOR_ID, [], 'build'), 'string');
  assert.equal(typeof refuseStart(OPERATOR_ID, steps([], [HANDOFF]), 'build'), 'string');
  assert.equal(
    typeof refuseStart(OPERATOR_ID, steps([], [label(1, 'agent:plan', OPERATOR_ID)]), 'build'),
    'string',
  );
  // An older approval cannot vouch for a newer start by the App or another stage.
  assert.equal(
    typeof refuseStart(
      OPERATOR_ID,
      steps([], [label(0, 'agent:build', OPERATOR_ID), HANDOFF]),
      'build',
    ),
    'string',
  );
  assert.equal(
    typeof refuseStart(
      OPERATOR_ID,
      steps([], [label(0, 'agent:build', OPERATOR_ID), label(1, 'agent:plan', OPERATOR_ID)]),
      'build',
    ),
    'string',
  );
  assert.equal(
    refuseStart(OPERATOR_ID, steps([], [label(1, 'agent:build', OPERATOR_ID)]), 'build'),
    null,
  );
  assert.equal(
    refuseStart(OPERATOR_ID, steps([comment(1, '/approve', OPERATOR_ID)], []), 'build'),
    null,
  );
  // A later Continue is not a start, so the latest start still supplies the proof.
  assert.equal(
    refuseStart(OPERATOR_ID, steps(CONTINUE, [label(0, 'agent:build', OPERATOR_ID)]), 'build'),
    null,
  );
});

test('a plan hands off only when a Continue started it and nothing came after', () => {
  assert.equal(armedContinue(steps(CONTINUE, PLAN)), 'build');
  assert.equal(armedContinue(steps([], PLAN)), null);
  assert.equal(armedContinue(steps(CONTINUE, [...PLAN, HANDOFF])), null);
  // The operator's /plan after the Continue's plan is a fresh plan, unapproved.
  assert.equal(armedContinue(steps([...CONTINUE, comment(2, '/plan', OPERATOR_ID)], PLAN)), null);
});
