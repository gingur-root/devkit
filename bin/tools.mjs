// Resolution for the tools devkit manages on a consumer's behalf.
//
// Consumers depend on `@gingur-root/devkit` alone, so oxlint, oxfmt and lint-staged
// are devkit's own dependencies — under pnpm's strict layout they never appear
// in the consumer's `node_modules/.bin`. Nothing may invoke them by bare name.
// Everything goes through `toolBin`, which resolves them out of devkit's own
// install tree from wherever devkit happens to be installed.
//
// This module is JavaScript while the rest of bin/ is TypeScript, and that is
// deliberate — see tools.d.mts for why.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { constants } from 'node:os';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

export function toolBin(pkg) {
  const manifest = require.resolve(`${pkg}/package.json`);
  const { bin } = JSON.parse(readFileSync(manifest, 'utf8'));
  const entry = typeof bin === 'string' ? bin : bin[pkg];
  // Reading an arbitrary package's manifest is genuinely fallible, and the
  // alternative failure is a path join against undefined several frames later.
  if (!entry) throw new Error(`${pkg} declares no bin named "${pkg}"`);
  return join(dirname(manifest), entry);
}

// Every tool devkit manages ships a `#!/usr/bin/env node` script rather than a
// native binary (oxlint and oxfmt are thin shims over a `dist/cli.js`). Running
// them through process.execPath instead of the shebang keeps them on the same
// runtime that started devkit, and does not depend on the executable bit
// surviving a checkout on a filesystem that does not carry one.
export function toolArgv(pkg) {
  return [process.execPath, toolBin(pkg)];
}

export function toolCommand(pkg) {
  return toolArgv(pkg)
    .map((part) => JSON.stringify(part))
    .join(' ');
}

export function runTool(pkg, args) {
  const [exe, ...prefix] = toolArgv(pkg);
  const child = spawn(exe, [...prefix, ...args], { stdio: 'inherit' });

  // A tool killed by a signal has a null exit code. Report it the way a shell
  // does so a caller's `set -e` and CI both see a failure rather than a 0.
  child.on('exit', (code, signal) => {
    process.exit(signal ? 128 + (constants.signals[signal] ?? 0) : (code ?? 0));
  });
}
