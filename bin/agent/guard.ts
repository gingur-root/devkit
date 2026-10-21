import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import { trustedContents } from './github.ts';
import { patchPath } from './patch.ts';
import type { Result } from './result.ts';

export const GUARD_PREFIX = 'T-';
export const TEST_FILE = /(?:^|\/)(?:__tests__|tests?)\/|\.(?:test|spec)\.[^/]+$/;
export const GUARDED: RegExp[] = [
  /^\.github\/workflows\//,
  /(?:^|\/)(?:vite|vitest|playwright|jest|eslint|oxlint|oxfmt|prettier)\.(?:config|workspace)\.[^/]+$/,
  /(?:^|\/)\.(?:eslintrc|oxlintrc|prettierrc)(?:\.[^/]+)?$/,
  /(?:^|\/)(?:oxlintrc|oxfmt)(?:\.[^/]+)+$/,
];
// shortcut: detect JS test declarations by line; extend when a consumer uses other syntax.
const TEST_CASE = /\b(?:describe|it|test)(?:\.\w+)*\s*\(/;
const SKIP =
  /\b(?:describe|it|test)(?:\.\w+)*\.(?:skip|only|skipIf)\b|\b(?:xit|xdescribe|xtest|fit|fdescribe)\s*\(/;
const Package = z.object({ scripts: z.record(z.string(), z.string()).optional() });

type Finding = NonNullable<Result['findings']>[number];
interface FilePatch {
  before: string | null;
  after: string | null;
  added: { text: string; line: number }[];
  removed: string[];
}

function files(patch: string): FilePatch[] {
  const result: FilePatch[] = [];
  let file: FilePatch | undefined;
  let right = 0;
  let hunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const header = /^diff --git ("(?:\\.|[^"])*"|a\/.*?) ("(?:\\.|[^"])*"|b\/.*)$/.exec(line);
      if (!header) throw new Error(`Cannot read patch header: ${line}`);
      file = {
        before: patchPath(header[1]!).slice(2),
        after: patchPath(header[2]!).slice(2),
        added: [],
        removed: [],
      };
      result.push(file);
      hunk = false;
    } else if (file) {
      const start = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (start) {
        right = Number(start[1]);
        hunk = true;
      } else if (hunk) {
        if (line.startsWith('+')) file.added.push({ text: line.slice(1), line: right++ });
        else if (line.startsWith('-')) file.removed.push(line.slice(1));
        else if (line.startsWith(' ')) right++;
      } else if (line.startsWith('new file mode ')) file.before = null;
      else if (line.startsWith('deleted file mode ')) file.after = null;
      else if (line.startsWith('rename from ')) file.before = patchPath(line.slice(12));
      else if (line.startsWith('rename to ')) file.after = patchPath(line.slice(10));
      else if (line.startsWith('--- '))
        file.before =
          line === '--- /dev/null' ? null : patchPath(line.slice(4).replace(/\t$/, '')).slice(2);
      else if (line.startsWith('+++ '))
        file.after =
          line === '+++ /dev/null' ? null : patchPath(line.slice(4).replace(/\t$/, '')).slice(2);
    }
  }
  return result;
}

export async function changedScripts(
  repo: string,
  base: string,
  candidate: string,
  patch: string,
): Promise<string[]> {
  const changed: string[] = [];
  for (const file of files(patch)) {
    if (!file.before || !/(?:^|\/)package\.json$/.test(file.before)) continue;
    const read = async (path: string | null, ref: string) => {
      const blob =
        path &&
        (await trustedContents<{ content: string }>(
          repo,
          path.split('/').map(encodeURIComponent).join('/'),
          ref,
        ));
      return blob
        ? (Package.parse(JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8')))
            .scripts ?? {})
        : {};
    };
    const [before, after] = await Promise.all([
      read(file.before, base),
      read(file.after, candidate),
    ]);
    if (!isDeepStrictEqual(before, after)) changed.push(file.after ?? file.before);
  }
  return changed;
}

function guarded(path: string | null): boolean {
  return path !== null && GUARDED.some((pattern) => pattern.test(path));
}

export function guardFindings(
  patch: string,
  plan: string,
  scripts: string[],
  base = '',
): Finding[] {
  const findings: Finding[] = [];
  for (const file of files(patch)) {
    const beforeGuarded = guarded(file.before);
    const afterGuarded = guarded(file.after);
    const path =
      file.before &&
      ((TEST_FILE.test(file.before) && (!file.after || !TEST_FILE.test(file.after))) ||
        (beforeGuarded && !afterGuarded))
        ? file.before
        : (file.after ?? file.before!);
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|[^\\w./-])${escaped}($|[^\\w./-]|\\.(?=$|[^\\w./-]))`).test(plan)) continue;
    const reasons: string[] = [];
    const test = TEST_FILE.test(path);
    if (test && (!file.after || !TEST_FILE.test(file.after)))
      reasons.push('test file deleted or renamed away');
    if (
      test &&
      file.before &&
      file.removed.filter((text) => TEST_CASE.test(text)).length >
        file.added.filter(({ text }) => TEST_CASE.test(text)).length
    )
      reasons.push('test cases removed');
    const skip = test ? file.added.find(({ text }) => SKIP.test(text)) : undefined;
    if (skip) reasons.push('skip or focus added');
    if (beforeGuarded || afterGuarded) reasons.push('check configuration changed');
    if (scripts.includes(path)) reasons.push('package scripts changed');
    if (!reasons.length) continue;
    const evidence = reasons.join('; ');
    findings.push({
      id: `${GUARD_PREFIX}${path}`,
      axis: 'correctness',
      blocking: true,
      criterion: null,
      path,
      line: skip?.line ?? null,
      evidence,
      scenario: `${path} changed since ${base.slice(0, 7) || 'the base'}: ${evidence}.`,
      impact:
        'This can make CI pass by weakening a check, and the approved plan does not name this file.',
      fix: `Restore the check. If the change is intended, the planner names ${path} in the plan, which needs the operator's approval.`,
    });
  }
  return findings;
}
