// Locks the admission gate: the one expression that keeps everyone but the
// owner off every credential-holding job. devkit is public and a loosened gate
// fails silently, so its text is pinned twice (here and in
// .github/admission.txt) and every job is checked against it.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';

const ADMISSION =
  "github.repository_owner_id == '340382989' && github.actor_id == '2553213' && github.run_attempt == '1' && " +
  "(github.event_name == 'workflow_dispatch' || " +
  '(github.event_name == \'issues\' && github.event.action == \'labeled\' && contains(fromJSON(\'["agent:plan","agent:build","agent:research","agent:elevated"]\'), github.event.label.name)) || ' +
  "(github.event_name == 'issue_comment' && github.event.action == 'created' && (startsWith(github.event.comment.body, '/plan') || startsWith(github.event.comment.body, '/revise') || " +
  "startsWith(github.event.comment.body, '/approve'))))";

const root = new URL('../', import.meta.url);
const workflows = new URL('.github/workflows/', root);

// Splits on an operator at paren depth 0, outside string literals.
function topLevel(expr: string, op: '&&' | '||'): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === "'") quoted = !quoted;
    else if (quoted) continue;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && expr.startsWith(op, i)) {
      parts.push(expr.slice(start, i).trim());
      start = i + op.length;
      i += op.length - 1;
    }
  }
  parts.push(expr.slice(start).trim());
  return parts;
}

// The admission alone, or a top-level `&&` with `(<admission>)` as one operand.
function admits(condition: string): boolean {
  const expr = condition
    .trim()
    .replace(/^\$\{\{([\s\S]*)\}\}$/, '$1')
    .trim();
  if (expr === ADMISSION) return true;
  if (topLevel(expr, '||').length > 1) return false;
  return topLevel(expr, '&&').includes(`(${ADMISSION})`);
}

type Job = { if?: unknown; secrets?: unknown };

function jobs(): [string, Job][] {
  return readdirSync(workflows)
    .filter((f) => /\.ya?ml$/.test(f))
    .flatMap((file) => {
      const doc = parse(readFileSync(new URL(file, workflows), 'utf8')) as {
        jobs?: Record<string, Job>;
      };
      return Object.entries(doc.jobs ?? {}).map(([id, job]): [string, Job] => [
        `${file}#${id}`,
        job,
      ]);
    });
}

test('admission.txt holds exactly the pinned expression', () => {
  assert.equal(readFileSync(new URL('.github/admission.txt', root), 'utf8').trim(), ADMISSION);
});

test('the admission check accepts only the allowed forms', () => {
  assert.ok(admits(ADMISSION));
  assert.ok(admits(`\${{ ${ADMISSION} }}`));
  assert.ok(admits(`(${ADMISSION}) && (github.event_name == 'issues')`));
  assert.ok(admits(`always() && (${ADMISSION}) && (github.event_name == 'issues')`));
  assert.ok(!admits(`(${ADMISSION}) || github.actor_id == '1'`));
  assert.ok(!admits(`github.actor_id == '1' || (${ADMISSION}) && true`));
  assert.ok(!admits(`${ADMISSION} && true`), 'admission must be parenthesised when combined');
  assert.ok(!admits(ADMISSION.replace("'2553213'", "'1'")));
  assert.ok(!admits(`(${ADMISSION.replace(" && github.run_attempt == '1'", '')}) && true`));
  assert.ok(!admits("github.actor_id == '2553213'"));
});

test('every job that touches a secret, or names the gate, carries the exact admission', () => {
  for (const [name, job] of jobs()) {
    const text = JSON.stringify(job);
    const gated =
      // Inside an expression only: `secrets.scan.yml` and `secrets.fetch` are names, not secrets.
      /\$\{\{[^}]*\bsecrets\./.test(text) ||
      job.secrets !== undefined ||
      text.includes('repository_owner_id');
    if (!gated) continue;
    assert.equal(typeof job.if, 'string', `${name} holds credentials but has no if:`);
    assert.ok(
      admits(job.if as string),
      `${name}: if: is not the admission expression or (<admission>) && …`,
    );
  }
});
