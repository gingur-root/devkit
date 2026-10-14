// The contract every file under commands/ implements. devkit owns every
// command's flags, so an unknown one is a usage error.

import type { Command } from 'commander';

export interface ParsedCommand<Options = Record<string, unknown>> {
  kind: 'parsed';
  describe: string;
  /** Declare `.option()` / `.argument()` here; runs at registration time. */
  configure?(command: Command): void;
  run(options: Options, args: string[]): void | Promise<void>;
}

export type CommandModule = ParsedCommand;

/** Optional `index.ts` in a command directory, describing the group itself. */
export interface CommandGroup {
  describe: string;
}
