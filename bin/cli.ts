// devkit — one executable over the tooling devkit manages.
//
// A consumer's package.json declares `@gingur-root/devkit` and nothing else for
// lint/format/pre-commit, and calls these subcommands instead of raw tool
// binaries. devkit owns the versions; the subcommand names are the stable
// surface. Commands live one-per-file under commands/; see router.ts.
//
// devkit.mjs is the bin — it installs the TypeScript loader and imports this.

import { fileURLToPath } from 'node:url';

import { Command } from 'commander';

import { register } from './router.ts';

const program = new Command('devkit').description(
  'Managed lint, format and pre-commit tooling for @gingur projects',
);

await register(program, fileURLToPath(new URL('./commands', import.meta.url)));

// Displayed help is a success even when Commander reaches it by erroring — a
// bare `devkit`, or a group named without a subcommand, should print usage and
// exit 0. Only a real usage error is a 2.
const INFORMATIONAL = /^commander\.(help|version)/;

// Commander exits 1 on a usage error; devkit uses 2, and the tests pin it.
// `copyInheritedSettings` would carry the override down, but Commander only
// calls it from `.command()`, never from `addCommand` — so it is applied to
// every node instead. Without this, `devkit frobnicate` exits 2 while
// `devkit hooks uninstall` exits 1.
function pinExitCodes(command: Command): void {
  command.exitOverride((err) => process.exit(INFORMATIONAL.test(err.code) ? 0 : 2));
  command.commands.forEach(pinExitCodes);
}
pinExitCodes(program);

await program.parseAsync(process.argv);
