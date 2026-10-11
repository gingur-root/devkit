// File-based routing: the directory structure under commands/ is the command
// path. `commands/hooks/install.ts` is `devkit hooks install`. Adding a command
// means adding a file; nothing here changes.
//
// Command modules are imported eagerly, and that is deliberate rather than a
// missed optimisation. Commander needs each command's option specs at
// registration time to generate help and to reject unknown flags, so a command
// cannot be loaded only once it is matched. The cost is kept near zero by
// keeping command modules thin — metadata and a handler, with heavy work behind
// a lazy import *inside* the handler.

import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { Command } from 'commander';

import type { CommandGroup, CommandModule } from './command.ts';

const COMMAND_EXT = '.ts';
const GROUP_FILE = `index${COMMAND_EXT}`;

/** A command file, and the command path its location implies. */
export interface Route {
  /** e.g. `['hooks', 'install']` */
  path: string[];
  file: string;
}

/**
 * Whether a file under commands/ is itself a command. Its own tests are not,
 * and neither is a GROUP_FILE — that describes the directory it sits in.
 */
function isCommandFile(name: string): boolean {
  return extname(name) === COMMAND_EXT && !name.includes('.test.') && name !== GROUP_FILE;
}

/** Walk a commands directory into routes, depth-first, alphabetically. */
export async function discover(dir: string, prefix: string[] = []): Promise<Route[]> {
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const routes: Route[] = [];

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      routes.push(...(await discover(full, [...prefix, entry.name])));
    } else if (isCommandFile(entry.name)) {
      routes.push({ path: [...prefix, basename(entry.name, COMMAND_EXT)], file: full });
    }
  }

  return routes;
}

async function load<T>(file: string): Promise<T> {
  // A bare Windows path is not a valid ESM specifier.
  return (await import(pathToFileURL(file).href)).default as T;
}

/**
 * Find or create the Command that owns `path`'s final segment, creating
 * intermediate group commands as needed.
 */
async function parentOf(program: Command, path: string[], dir: string): Promise<Command> {
  let parent = program;
  let groupDir = dir;

  for (const segment of path.slice(0, -1)) {
    groupDir = join(groupDir, segment);

    const existing = parent.commands.find((c) => c.name() === segment);
    if (existing) {
      parent = existing;
      continue;
    }

    // A group's index.ts is optional, so its absence is not an error — but a
    // broken one is. Testing for the file keeps an import failure loud instead
    // of quietly falling back to the generated description.
    const groupFile = join(groupDir, GROUP_FILE);
    const meta = existsSync(groupFile) ? await load<CommandGroup>(groupFile) : undefined;

    const group = new Command(segment).description(meta?.describe ?? `${segment} commands`);
    parent.addCommand(group);
    parent = group;
  }

  return parent;
}

/** Register every command found under `dir` onto `program`. */
export async function register(program: Command, dir: string): Promise<Route[]> {
  // Pass-through in a subcommand requires positional options on the program,
  // so that `devkit lint --fix` does not resolve `--fix` against devkit itself.
  program.enablePositionalOptions();

  const routes = await discover(dir);

  for (const route of routes) {
    const module = await load<CommandModule>(route.file);
    const command = new Command(route.path.at(-1)).description(module.describe);

    if (module.kind === 'passthrough') {
      command
        .argument('[args...]')
        // Without this an unmodelled flag is an error; with it, it becomes an
        // ordinary command-argument and reaches the tool. This is what makes
        // `devkit lint --fix` work.
        .allowUnknownOption()
        // And this keeps options *after* a path from being reparsed as devkit's:
        // `devkit lint src/ --fix`.
        .passThroughOptions()
        // Commander would otherwise answer `devkit lint --help` itself. A blind
        // wrapper must let the tool answer for its own flags.
        .helpOption(false)
        .action((args: string[]) => module.run(args));
    } else {
      module.configure?.(command);
      command.action(() => module.run(command.opts(), command.args));
    }

    (await parentOf(program, route.path, dir)).addCommand(command);
  }

  return routes;
}
