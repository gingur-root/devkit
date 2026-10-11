import { toolCommand } from '../bin/tools.mjs';

// Hand both tools everything staged rather than curating an extension
// allowlist. oxfmt's detection is a linguist-style table keyed on full filename
// as well as extension -- it formats `.webmanifest`, `.pcss`, `.code-workspace`
// and bare `.prettierrc`, among others -- so any allowlist drifts from it
// silently, leaving file types that a repo-wide `oxfmt --check` rejects but the
// hook waved through. That divergence is what a shared config exists to prevent.
//
// Safe because both tools ignore input they do not recognise, leaving it
// byte-identical -- binaries and lockfiles included. A file whose extension
// oxfmt does recognise but whose contents it cannot parse (malformed JSON, a
// UTF-16 payload) still fails the commit, which is the correct outcome and not
// something the flags below suppress.
//
// One exception, latent today: oxfmt follows a symlink and rewrites its target,
// which lint-staged will not re-stage. No repo in the fleet tracks a symlink.
//
// Both need --no-error-on-unmatched-pattern, which despite the name is not an
// edge case: each tool exits non-zero when *nothing* it was handed is
// actionable, so without it a commit of only images, or only shell scripts,
// fails. That is a clean commit.
//
// The commands are absolute rather than bare `oxfmt` / `oxlint`: the tools are
// devkit's dependencies, not the consumer's, so under pnpm they are absent from
// the consumer's node_modules/.bin. toolCommand resolves them from devkit's own
// tree and quotes the result, so a path containing a space still works.
const FORMAT = `${toolCommand('oxfmt')} --no-error-on-unmatched-pattern`;
const LINT = `${toolCommand('oxlint')} --fix --no-error-on-unmatched-pattern`;

export default {
  // Lint first, format last. `oxlint --fix` rewrites code without regard for
  // layout, so the formatter has to run afterwards for the committed state to
  // be what `oxfmt --check` gates on in CI. One task group rather than two
  // globs, because lint-staged runs separate groups concurrently and these two
  // write the same files.
  //
  // Consumers extending this: merge extra commands into this array. A second
  // glob would overlap '*' and run concurrently with it.
  '*': [LINT, FORMAT],
};
