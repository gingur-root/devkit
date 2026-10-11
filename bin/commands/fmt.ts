import type { PassthroughCommand } from '../command.ts';
import { runTool } from '../tools.mjs';

export default {
  kind: 'passthrough',
  describe: 'Run oxfmt over the repo',
  run(argv) {
    runTool('oxfmt', argv);
  },
} satisfies PassthroughCommand;
