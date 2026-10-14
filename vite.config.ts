import { defineConfig } from 'vite-plus';

import devkit from './configs/vite.mjs';

export default defineConfig({
  ...devkit,
  // The stub's red build is badly formatted on purpose: it must fail a target repo's CI.
  fmt: { ...devkit.fmt, ignorePatterns: ['bin/agent/fixtures/build.red.md'] },
});
