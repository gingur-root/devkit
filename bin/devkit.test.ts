// The CLI's contract end to end: subcommands reach the right tool, arguments
// pass through untouched, and exit codes mean what they say.
//
// Spawns bin/devkit.mjs — the real bin, loader and all — not cli.ts directly.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished, test } from 'vite-plus/test';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('./devkit.mjs', import.meta.url));

function devkit(args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

/** A temp directory removed when the suite finishes, so runs do not leak. */
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('no command prints usage listing every command, and exits 0', () => {
  const { status, stdout, stderr } = devkit([]);
  assert.equal(status, 0);
  for (const name of ['lint', 'fmt', 'staged', 'hooks']) {
    assert.match(stdout + stderr, new RegExp(`^\\s+${name}\\b`, 'm'));
  }
});

test('--help prints usage and exits 0', () => {
  assert.equal(devkit(['--help']).status, 0);
});

test('an unknown command exits 2 and names what was passed', () => {
  const { status, stderr } = devkit(['frobnicate']);
  assert.equal(status, 2);
  assert.match(stderr, /frobnicate/);
});

test('an unknown subcommand of a group exits 2', () => {
  // Regression: exitOverride is not inherited by addCommand, so this exited 1
  // while a top-level unknown command exited 2.
  const { status, stderr } = devkit(['hooks', 'uninstall']);
  assert.equal(status, 2);
  assert.match(stderr, /uninstall/);
});

test('a group named without a subcommand prints its help and exits 0', () => {
  const { status, stdout, stderr } = devkit(['hooks']);
  assert.equal(status, 0);
  assert.match(stdout + stderr, /install/);
});

// One case per wrapped tool, proving the argument reached the intended tool.
const WRAPPED: [string, RegExp][] = [
  ['lint', /oxlint|oxlintrc/i],
  ['fmt', /oxfmt|format/i],
  ['staged', /lint-staged/i],
];

for (const [command, signature] of WRAPPED) {
  test(`${command} runs its tool and passes arguments through`, () => {
    const { status, stdout, stderr } = devkit([command, '--help']);
    assert.equal(status, 0, stderr);
    assert.match(stdout + stderr, signature);
  });
}

test('--help on a pass-through command reaches the tool, not devkit', () => {
  // oxlint's help names an oxlint concept and not devkit's other subcommands.
  const { stdout, stderr } = devkit(['lint', '--help']);
  assert.match(stdout + stderr, /oxlintrc|oxlint/i);
  assert.doesNotMatch(stdout + stderr, /Run lint-staged/);
});

test('--help on a parsed command is answered by devkit', () => {
  const { status, stdout, stderr } = devkit(['hooks', 'install', '--help']);
  assert.equal(status, 0);
  assert.match(stdout + stderr, /Install devkit's git hooks/i);
});

test('a flag devkit does not model still reaches the tool', () => {
  // The escape hatch. `--fix` is oxlint's, unknown to devkit, and must not be
  // swallowed by the router.
  const { status, stderr } = devkit(['lint', '--fix']);
  assert.equal(status, 0, stderr);
});

test('a flag after a positional still reaches the tool', () => {
  const { status, stderr } = devkit(['lint', 'bin', '--quiet']);
  assert.equal(status, 0, stderr);
});

test("a tool's non-zero exit becomes the CLI's exit code", () => {
  const { status } = devkit(['lint', '--not-a-real-flag']);
  assert.equal(status, 1);
});

test('lint does not walk node_modules, with no .gitignore and no local config', () => {
  // The shared config's ignorePatterns are inert for consumers — oxlint honours
  // them only from a config at the repo root, never from one inside
  // node_modules. Without the flags lint.ts injects, this walks the whole tree:
  // a real consumer fixture reported 2366 files instead of 2.
  const dir = scratch('devkit-ignore-');
  mkdirSync(join(dir, 'node_modules', 'junk'), { recursive: true });
  writeFileSync(join(dir, 'app.js'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'node_modules', 'junk', 'bad.js'), 'var x = 1; x = 2;\n');

  // Explicit format: oxlint switches to a terser one, with no file count, when
  // it detects an AI agent's environment, which is where the pipeline runs this.
  const { stdout, stderr } = spawnSync(process.execPath, [CLI, 'lint', '--format', 'default'], {
    cwd: dir,
    encoding: 'utf8',
  });

  const scanned = (stdout + stderr).match(/on (\d+) files?/);
  assert.ok(scanned, `no file count in output:\n${stdout}${stderr}`);
  assert.equal(scanned[1], '1', 'lint reached into node_modules');
});
