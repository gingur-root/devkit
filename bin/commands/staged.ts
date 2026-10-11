import type { PassthroughCommand } from '../command.ts';
import { runTool } from '../tools.mjs';

export default {
  kind: 'passthrough',
  describe: 'Run lint-staged, for a pre-commit hook',
  run(argv) {
    runTool('lint-staged', argv);
  },
} satisfies PassthroughCommand;
