// Shared Vite+ config: lint, format and staged-file rules. Consumers spread it
// into their own vite.config.ts:
//   import { defineConfig } from 'vite-plus';
//   import devkit from '@gingur-root/devkit/vite';
//   export default defineConfig({ ...devkit });
import lint from './oxlintrc.base.json' with { type: 'json' };
import fmt from './oxfmt.config.mjs';

export default {
  lint,
  fmt,
  // Everything staged, not an extension allowlist: oxfmt detects file types by
  // full name as well as extension, so an allowlist drifts from what
  // `vp fmt --check` gates on in CI. Both tools leave files they don't know alone.
  staged: { '*': 'vp check --fix --no-error-on-unmatched-pattern' },
};
