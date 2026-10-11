// The bug this encodes: husky points core.hooksPath at .husky/_, which it
// generates during install and gitignores. core.hooksPath is repository config,
// so a worktree inherits it and has no such directory — and git runs no hook,
// prints nothing, and exits 0. Three worktrees of a real consumer had been
// committing with every check silently skipped.
//
// Everything here runs against real `git worktree add`, because the whole
// failure lives in git's behaviour rather than ours.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('./devkit.mjs', import.meta.url));
const SHIM = fileURLToPath(new URL('./commands/hooks/shim.sh', import.meta.url));

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();
}

/** A temp directory removed when the suite finishes, so runs do not leak. */
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A repo with the devkit shim installed and a hook body that marks a file. */
function repo() {
  const dir = scratch('devkit-hooks-');
  const main = join(dir, 'main');
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main', '.');

  // Stand in for node_modules/.bin so the shim finds tooling.
  mkdirSync(join(main, 'node_modules', '.bin'), { recursive: true });

  mkdirSync(join(main, '.husky'));
  writeFileSync(join(main, '.husky', 'pre-commit'), `echo RAN >> "$PWD/ran.txt"\n`);

  mkdirSync(join(main, '.githooks'));
  writeFileSync(join(main, '.githooks', 'pre-commit'), readFileSync(SHIM), { mode: 0o755 });
  git(main, 'config', 'core.hooksPath', '.githooks');

  writeFileSync(join(main, 'seed.txt'), 'seed\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-qm', 'seed');
  return { dir, main };
}

function commit(cwd: string, name: string, env: Record<string, string> = {}) {
  writeFileSync(join(cwd, name), 'x\n');
  git(cwd, 'add', name);
  return spawnSync('git', ['commit', '-m', name], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
      ...env,
    },
  });
}

test('the hook runs in the main checkout', () => {
  const { main } = repo();
  const r = commit(main, 'a.txt');
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(join(main, 'ran.txt'), 'utf8'), /RAN/);
});

test('a worktree with no dependencies anywhere fails loudly, not silently', () => {
  const { dir, main } = repo();
  // Neither the worktree nor the main checkout has tooling — nothing to fall
  // back to. Under husky this is the silent-skip case; the shim must refuse
  // rather than let a commit look checked when nothing ran.
  rmSync(join(main, 'node_modules'), { recursive: true, force: true });
  const wt = join(dir, 'wt');
  git(main, 'worktree', 'add', '-q', '-b', 'feature', wt);

  const r = commit(wt, 'b.txt');
  assert.notEqual(r.status, 0, 'commit succeeded with hooks unavailable');
  assert.match(r.stderr, /pnpm install/);
  assert.match(r.stderr, /refusing to commit/);
});

test('a worktree with no dependencies of its own falls back to the main checkout', () => {
  // The common real case, and the one husky gets wrong: `git worktree add`
  // then commit, without installing anything in the worktree.
  const { dir, main } = repo();
  const wt = join(dir, 'wt-fallback');
  git(main, 'worktree', 'add', '-q', '-b', 'fallback', wt);
  assert.ok(!existsSync(join(wt, 'node_modules')), 'fixture should have no worktree deps');

  const r = commit(wt, 'd.txt');
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(join(wt, 'ran.txt'), 'utf8'), /RAN/);
});

test('a worktree still runs the hook when the main checkout has dependencies', () => {
  const { dir, main } = repo();
  const wt = join(dir, 'wt2');
  git(main, 'worktree', 'add', '-q', '-b', 'feature2', wt);
  // Give the worktree its own node_modules, as `pnpm install` there would.
  mkdirSync(join(wt, 'node_modules', '.bin'), { recursive: true });

  const r = commit(wt, 'c.txt');
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(join(wt, 'ran.txt'), 'utf8'), /RAN/);
});

test('the installed shim is executable and tracked-ready', () => {
  // A non-executable hook is skipped too, with only a `hint:` on stderr.
  const { main } = repo();
  assert.ok(statSync(join(main, '.githooks', 'pre-commit')).mode & 0o111);
  assert.equal(git(main, 'ls-files', '.githooks/pre-commit'), '.githooks/pre-commit');
});

test('devkit hooks install writes the shim and points core.hooksPath at it', () => {
  const dir = scratch('devkit-install-');
  git(dir, 'init', '-q', '-b', 'main', '.');

  // Stand in for Git for Windows, which ignores the filesystem's exec bit. With
  // chmodSync this assertion would pass on Linux and record 100644 on Windows —
  // a shim committed from there would be silently inert for everyone, which is
  // the failure this command exists to prevent. Only `update-index --chmod`
  // survives this setting.
  git(dir, 'config', 'core.filemode', 'false');

  const r = spawnSync(process.execPath, [CLI, 'hooks', 'install'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(dir, 'config', '--get', 'core.hooksPath'), '.githooks');

  // Tracked mode: what every OTHER checkout receives.
  assert.match(
    git(dir, 'ls-files', '-s', '.githooks/pre-commit'),
    /^100755 /,
    'shim is not tracked executable — git will skip it everywhere else',
  );
});

test('hooks install outside a git repository is a no-op, not a failed install', () => {
  // It runs from `prepare`, so it fires wherever dependencies are installed —
  // including a Docker build that copies source without .git.
  const dir = scratch('devkit-nogit-');
  const r = spawnSync(process.execPath, [CLI, 'hooks', 'install'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /not a git repository/);
});

test('a missing hook body fails loudly rather than passing silently', () => {
  // The migration note says to delete `.husky/_`; deleting `.husky/` wholesale
  // is one slip away, and that must not look like a commit that passed.
  const { main } = repo();
  rmSync(join(main, '.husky'), { recursive: true, force: true });

  const r = commit(main, 'e.txt');
  assert.notEqual(r.status, 0, 'commit succeeded with no hook body');
  assert.match(r.stderr, /does not exist/);
});

test('install sets the filesystem exec bit even when the source lost it', () => {
  // `pnpm pack` normalises everything except package.json `bin` entries to 644,
  // so a consumer who installed a packed tarball has shim.sh at 644.
  // copyFileSync carries the SOURCE's mode, so without chmodSync the installed
  // hook is 644 and git skips it with only a `hint:`. In this repo shim.sh is
  // 755, which is why asserting on a plain install proves nothing — stand in
  // for the published layout by copying bin/ and stripping the bit.
  const dir = scratch('devkit-packed-');
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  // bin/ and configs/ both ship, and the router imports every command eagerly —
  // lint.ts reads configs/oxlintrc.base.json at module scope.
  cpSync(join(repoRoot, 'bin'), join(dir, 'bin'), { recursive: true });
  cpSync(join(repoRoot, 'configs'), join(dir, 'configs'), { recursive: true });
  chmodSync(join(dir, 'bin', 'commands', 'hooks', 'shim.sh'), 0o644);
  // Dependencies resolve as an installed package's would.
  symlinkSync(join(repoRoot, 'node_modules'), join(dir, 'node_modules'));

  const work = join(dir, 'repo');
  mkdirSync(work);
  git(work, 'init', '-q', '-b', 'main', '.');

  const r = spawnSync(process.execPath, [join(dir, 'bin', 'devkit.mjs'), 'hooks', 'install'], {
    cwd: work,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(
    statSync(join(work, '.githooks', 'pre-commit')).mode & 0o111,
    'shim is not executable on disk — git will skip it in this checkout',
  );
});

test('install works when prepare runs from a subdirectory', () => {
  // `prepare` runs wherever dependencies are installed, which in a pnpm
  // workspace is a package directory. update-index takes a CWD-relative path,
  // so running git from the process directory failed with "does not exist"
  // AFTER copying the shim and BEFORE setting core.hooksPath — a half install.
  const dir = scratch('devkit-subdir-');
  git(dir, 'init', '-q', '-b', 'main', '.');
  const pkg = join(dir, 'packages', 'app');
  mkdirSync(pkg, { recursive: true });

  const r = spawnSync(process.execPath, [CLI, 'hooks', 'install'], { cwd: pkg, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(dir, 'config', '--get', 'core.hooksPath'), '.githooks');
  assert.match(git(dir, 'ls-files', '-s', '.githooks/pre-commit'), /^100755 /);
});

test('an exported CDPATH does not corrupt the resolved paths', () => {
  // `cd` echoes its destination when CDPATH is set, which would land inside the
  // command substitutions that resolve $here and $main — the hook then refuses
  // a commit while naming a directory that does exist.
  const { main } = repo();
  const r = commit(main, 'cdpath.txt', { CDPATH: '.' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(join(main, 'ran.txt'), 'utf8'), /RAN/);
});

test("devkit's own committed shim matches the one it installs", () => {
  // Two copies of the same file; nothing else keeps them in step.
  const tracked = fileURLToPath(new URL('../.githooks/pre-commit', import.meta.url));
  assert.equal(readFileSync(tracked, 'utf8'), readFileSync(SHIM, 'utf8'));
});
