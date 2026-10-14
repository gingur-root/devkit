import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ParsedCommand } from '../../command.ts';
import { git } from '../../git.ts';

const HOOKS_DIR = '.githooks';
const BODY_DIR = '.husky';
const SHIM = fileURLToPath(new URL('./shim.sh', import.meta.url));

/** Hooks devkit installs a shim for. The shim dispatches on its own basename. */
const HOOKS = ['pre-commit'];

export default {
  kind: 'parsed',
  describe: "Install devkit's git hooks",
  run() {
    // This runs from `prepare`, so it fires on every install — including ones
    // with no git repository at all, such as a Docker build that copies source
    // without .git. That is a normal condition, not a miswiring, and it must
    // not fail the install.
    // Every git call after this one runs from the repo root, because
    // `update-index` takes a path relative to the process's directory, and
    // `prepare` runs wherever dependencies are installed, which in a workspace
    // is a package subdirectory, not the root.
    let root: string;
    try {
      root = git(process.cwd(), ['rev-parse', '--show-toplevel']);
    } catch {
      console.log('devkit: not a git repository — skipping hook install');
      return;
    }

    const dir = join(root, HOOKS_DIR);
    mkdirSync(dir, { recursive: true });

    for (const hook of HOOKS) {
      const path = join(dir, hook);
      copyFileSync(SHIM, path);

      // Both modes, because they are different things and each fails alone.
      //
      // Filesystem bit: what git checks before RUNNING the hook in this
      // checkout. copyFileSync carries the source's mode, but `pnpm pack`
      // normalises everything except package.json `bin` entries to 644 — so a
      // consumer who installed a packed tarball gets the shim at 644 and git
      // skips it with only a `hint:`. The next `git add` then drags the tracked
      // mode down with it, so update-index alone is not durable either.
      chmodSync(path, 0o755);

      // Tracked bit: what every OTHER checkout receives. On Windows chmodSync
      // cannot set a POSIX bit and Git for Windows runs core.filemode=false,
      // so the recorded mode would be 100644 and the shim inert for everyone.
      // update-index --chmod is honoured regardless of core.filemode.
      git(root, ['update-index', '--add', '--chmod=+x', `${HOOKS_DIR}/${hook}`]);

      // The shim runs the body and refuses when it is missing, so say so at
      // install time rather than at the first commit.
      if (!existsSync(join(root, BODY_DIR, hook))) {
        console.log(
          `devkit: no ${BODY_DIR}/${hook} yet — create it, or the ${hook} hook will fail`,
        );
      }
    }

    // The shim looks for <root>/node_modules/.bin. In a workspace that declares
    // devkit in a package rather than at the root, pnpm creates a root
    // node_modules with no .bin — the install succeeds and then every commit is
    // refused. It fails closed, but the first commit is a late and confusing
    // place to learn it, and the obvious remedy (`pnpm install`) is a dead end.
    if (!existsSync(join(root, 'node_modules', '.bin'))) {
      console.log(`devkit: ${root}/node_modules/.bin does not exist`);
      console.log(
        'devkit: hooks will refuse to run — declare @gingur-root/devkit at the repo root',
      );
    }

    git(root, ['config', 'core.hooksPath', HOOKS_DIR]);

    console.log(`devkit: installed ${HOOKS.map((h) => `${HOOKS_DIR}/${h}`).join(', ')}`);
    console.log(`devkit: core.hooksPath -> ${HOOKS_DIR}`);
    console.log(`devkit: commit ${HOOKS_DIR}/ — tracked is what makes it work in worktrees`);
  },
} satisfies ParsedCommand;
