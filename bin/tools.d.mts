// Types for tools.mjs.
//
// tools.mjs stays JavaScript on purpose. It is the one module loaded from two
// runtimes: the devkit CLI (which installs the TypeScript loader) and
// lint-staged, which devkit spawns as a plain `node` child that has no loader
// and imports configs/lint-staged.config.js. A .ts here would break the hook.

/**
 * Absolute path to a managed tool's executable. `pkg` is the npm package name,
 * which is also its bin name for every tool devkit manages.
 */
export function toolBin(pkg: string): string;

/** The argv prefix that runs a managed tool: `[execPath, binPath]`. */
export function toolArgv(pkg: string): [string, string];

/**
 * A shell command string that runs a managed tool, for callers that can only
 * express a command as text — lint-staged task arrays, chiefly.
 */
export function toolCommand(pkg: string): string;

/** Run a managed tool in the caller's cwd and exit with its result. */
export function runTool(pkg: string, args: string[]): void;
