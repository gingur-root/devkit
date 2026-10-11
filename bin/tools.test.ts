// Guards the one thing that silently breaks every consumer: resolving a
// managed tool out of devkit's own tree rather than the consumer's .bin.
//
// No network, no fixtures — the tools are devkit's own dependencies, so the
// real resolution path is the one under test.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { test } from 'node:test';

import { toolArgv, toolBin, toolCommand } from './tools.mjs';

const MANAGED = ['oxlint', 'oxfmt', 'lint-staged'];

for (const pkg of MANAGED) {
  test(`toolBin(${pkg}) resolves to a file that exists`, () => {
    const bin = toolBin(pkg);
    assert.ok(isAbsolute(bin), `${bin} is not absolute`);
    assert.ok(existsSync(bin), `${bin} does not exist`);
  });

  test(`toolBin(${pkg}) resolves inside devkit's own tree, not a consumer .bin`, () => {
    assert.match(toolBin(pkg), /node_modules/);
  });

  test(`${pkg} is a node script, so running it under process.execPath is correct`, () => {
    assert.ok(readFileSync(toolBin(pkg), 'utf8').startsWith('#!'));
  });

  test(`toolArgv(${pkg}) runs the tool`, () => {
    const [exe, ...args] = toolArgv(pkg);
    assert.equal(exe, process.execPath);
    execFileSync(exe, [...args, '--help'], { stdio: 'ignore' });
  });

  test(`toolCommand(${pkg}) quotes each argv entry whole`, () => {
    // A path containing a space must survive as one argument, so each entry is
    // quoted rather than joined raw. Recovering argv from the quoted segments
    // is the property that matters, not the quoting style.
    const quoted = toolCommand(pkg).match(/"(?:[^"\\]|\\.)*"/g);
    assert.deepEqual(
      quoted?.map((s) => JSON.parse(s) as string),
      toolArgv(pkg),
    );
  });
}

test('an unmanaged package is a resolution error, not a silent bare command', () => {
  assert.throws(() => toolBin('definitely-not-a-devkit-tool'), { code: 'MODULE_NOT_FOUND' });
});
