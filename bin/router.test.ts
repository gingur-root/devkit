// The guard that makes file-based routing trustworthy: every file under
// commands/ must actually become a command. A file that silently fails to
// register looks exactly like a file that was never added.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';

import type { CommandModule } from './command.ts';
import { discover, register } from './router.ts';

const COMMANDS = fileURLToPath(new URL('./commands', import.meta.url));

/** Every command path Commander actually ended up with, as dotted strings. */
function registered(command: Command, prefix: string[] = []): string[] {
  return command.commands.flatMap((child) => {
    const path = [...prefix, child.name()];
    // `help` is Commander's own, not ours; groups contribute their children.
    if (child.name() === 'help') return [];
    return child.commands.length ? registered(child, path) : [path.join('.')];
  });
}

async function build() {
  const program = new Command('devkit');
  const routes = await register(program, COMMANDS);
  return { program, routes };
}

/** A temp directory removed when the suite finishes, so runs do not leak. */
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('every discovered route becomes a registered command', async () => {
  const { program, routes } = await build();
  assert.deepEqual(registered(program).sort(), routes.map((r) => r.path.join('.')).sort());
});

test('the commands/ tree on disk matches the registered paths', async () => {
  // Deliberately re-walks the filesystem rather than reusing discover(), so a
  // bug in discover() cannot make this assertion agree with itself.
  const onDisk: string[] = [];
  for (const entry of await readdir(COMMANDS, { withFileTypes: true, recursive: true })) {
    if (!entry.name.endsWith('.ts') || entry.name.includes('.test.')) continue;
    if (entry.name === 'index.ts') continue; // group metadata, not a command
    const dir = entry.parentPath.slice(COMMANDS.length).split('/').filter(Boolean);
    onDisk.push([...dir, entry.name.replace(/\.ts$/, '')].join('.'));
  }

  const { program } = await build();
  assert.deepEqual(registered(program).sort(), onDisk.sort());
});

test('every command declares a known kind and a description', async () => {
  const { routes } = await build();
  assert.ok(routes.length > 0, 'discovered no commands at all');

  for (const route of routes) {
    const module = (await import(route.file)).default as CommandModule;
    assert.ok(
      module.kind === 'passthrough' || module.kind === 'parsed',
      `${route.path.join(' ')} has kind ${String(module.kind)}`,
    );
    assert.ok(module.describe.length > 0, `${route.path.join(' ')} has no description`);
  }
});

test('a pass-through command accepts variadic arguments so nothing is dropped', async () => {
  // Flag semantics are asserted behaviourally in devkit.test.ts — Commander
  // keeps allowUnknownOption/passThroughOptions/helpOption on private fields,
  // and pinning those here would test the library rather than the router. What
  // belongs here is that the router gave the command somewhere to put argv.
  const { program } = await build();
  const lint = program.commands.find((c) => c.name() === 'lint');
  assert.ok(lint, 'lint was not registered at all');

  const [argument, ...rest] = lint.registeredArguments;
  assert.equal(rest.length, 0, 'pass-through takes exactly one argument slot');
  assert.ok(argument?.variadic, 'pass-through args must be variadic');
});

test('discover ignores test files and group metadata', async () => {
  const routes = await discover(COMMANDS);
  assert.ok(!routes.some((r) => r.file.includes('.test.')));
  assert.ok(!routes.some((r) => r.path.at(-1) === 'index'));
});

test('a parsed command is handed its options and its arguments', async () => {
  // The other half of the kind split, and the half nothing else reaches: the
  // only parsed command devkit ships takes neither flags nor arguments, so a
  // fixture is the only way to assert the router wires them the right way round.
  const dir = scratch('devkit-router-');
  const received = join(dir, 'received.json');
  writeFileSync(
    join(dir, 'probe.ts'),
    [
      "import { writeFileSync } from 'node:fs';",
      'export default {',
      "  kind: 'parsed' as const,",
      "  describe: 'probe',",
      '  configure(command) {',
      "    command.argument('[names...]').option('--loud');",
      '  },',
      '  run(options: unknown, args: string[]) {',
      `    writeFileSync(${JSON.stringify(received)}, JSON.stringify({ options, args }));`,
      '  },',
      '};',
    ].join('\n'),
  );

  const program = new Command('devkit');
  await register(program, dir);
  await program.parseAsync(['probe', '--loud', 'a', 'b'], { from: 'user' });

  assert.deepEqual(JSON.parse(readFileSync(received, 'utf8')), {
    options: { loud: true },
    args: ['a', 'b'],
  });
});
