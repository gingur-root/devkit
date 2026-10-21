import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { CANDIDATE_FILE, PLAN_FILE, RESEARCH_FILE, RESULT_FILE } from './job.ts';

const Findings = z
  .array(z.object({ File: z.string().min(1), RuleID: z.string().min(1) }))
  .nonempty();
const config = fileURLToPath(new URL('../../actions/secrets.scan/gitleaks.toml', import.meta.url));

function failed(cause: string): { stage: 'validate'; reason: string } {
  return {
    stage: 'validate',
    reason: `the secret screen could not run (${cause}); nothing from this result was published`,
  };
}

/** Screen publishable output with the rules from the controller's trusted checkout. */
export function screen(out: string): { stage: 'validate'; reason: string } | null {
  let root: string | undefined;
  try {
    root = mkdtempSync(join(tmpdir(), 'publish-screen-'));
    const stage = join(root, 'text');
    mkdirSync(stage);
    for (const file of [RESULT_FILE, PLAN_FILE, RESEARCH_FILE, CANDIDATE_FILE]) {
      const source = join(out, file);
      if (!existsSync(source)) continue;
      if (!lstatSync(source).isFile()) return failed('expected a regular output file');
      let text = readFileSync(source, 'utf8');
      if (file === CANDIDATE_FILE) {
        let hunk = false;
        text = text
          .split('\n')
          .flatMap((line) => {
            if (line.startsWith('diff --git ')) hunk = false;
            if (line.startsWith('@@ ')) hunk = true;
            return line.startsWith('+') && (hunk || !line.startsWith('+++')) ? [line.slice(1)] : [];
          })
          .join('\n');
      }
      writeFileSync(join(stage, file), text);
    }
    const memory = join(out, 'memory');
    if (existsSync(memory) && lstatSync(memory).isDirectory()) {
      const directories = [memory];
      for (const directory of directories) {
        for (const file of readdirSync(directory, { withFileTypes: true })) {
          const source = join(directory, file.name);
          if (file.isDirectory()) directories.push(source);
          else if (file.isFile()) {
            const target = join(stage, relative(out, source));
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, readFileSync(source));
          }
        }
      }
    }
    const report = join(root, 'report.json');
    const scan = spawnSync(
      'gitleaks',
      [
        'dir',
        '--no-banner',
        '--redact',
        '--exit-code',
        '2',
        '--config',
        config,
        '-f',
        'json',
        '-r',
        report,
        '.',
      ],
      { cwd: stage, encoding: 'utf8' },
    );
    // Scanner diagnostics can include input text; never forward stdout, stderr or error messages.
    if (scan.error)
      return failed(
        'code' in scan.error && scan.error.code === 'ENOENT'
          ? 'gitleaks not found on PATH'
          : 'gitleaks spawn failed',
      );
    if (scan.status === 0) return null;
    if (scan.status !== 2) return failed(`gitleaks exit ${scan.status ?? 'unknown'}`);
    const findings = Findings.parse(JSON.parse(readFileSync(report, 'utf8')));
    return {
      stage: 'validate',
      reason: `secret-shaped text in ${[...new Set(findings.map((hit) => hit.File))].join(', ')} (${[...new Set(findings.map((hit) => hit.RuleID))].join(', ')}); nothing from this result was published`,
    };
  } catch {
    return failed('could not stage output or read the gitleaks report');
  } finally {
    if (root) rmSync(root, { recursive: true, force: true });
  }
}
