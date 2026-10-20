import { defineConfig } from 'vite-plus';

import devkit from './configs/vite.mjs';

export default defineConfig({
  ...devkit,
  fmt: {
    ...devkit.fmt,
    ignorePatterns: [
      // The stub's red build is badly formatted on purpose: it must fail a target repo's CI.
      'bin/agent/fixtures/build.red.md',
      // Written by the shadcn CLI; kept as it writes them so updates diff cleanly.
      'bin/dashboard/web/components/**',
      // Vendored from bradautomates/claude-video; the formatter breaks its tables.
      'skills/watch-video/**',
    ],
  },
});
