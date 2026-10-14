// The CLI's contract end to end: commands register, and exit codes mean what
// they say.
//
// Spawns bin/devkit.mjs — the real bin, loader and all — not cli.ts directly.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'vite-plus/test';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('./devkit.mjs', import.meta.url));

function devkit(args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

test('no command prints usage listing every command, and exits 0', () => {
  const { status, stdout, stderr } = devkit([]);
  assert.equal(status, 0);
  assert.match(stdout + stderr, /^\s+agent\b/m);
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
  const { status, stderr } = devkit(['agent', 'frobnicate']);
  assert.equal(status, 2);
  assert.match(stderr, /frobnicate/);
});

test('a group named without a subcommand prints its help and exits 0', () => {
  const { status, stdout, stderr } = devkit(['agent']);
  assert.equal(status, 0);
  assert.match(stdout + stderr, /^\s+run\b/m);
});

test('--help on a command is answered by devkit', () => {
  const { status, stdout, stderr } = devkit(['agent', 'run', '--help']);
  assert.equal(status, 0);
  assert.match(stdout + stderr, /Run one agent role/);
});
