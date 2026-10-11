import base from '../../configs/oxlintrc.base.json' with { type: 'json' };
import type { PassthroughCommand } from '../command.ts';
import { runTool } from '../tools.mjs';

// oxlint only honours `ignorePatterns` from the config at the repo root. A
// config shipped inside node_modules contributes none — verified: from there
// neither `node_modules/**`, `**/node_modules/**` nor `../../../**` has any
// effect, and passing it as `-c` does not help either, while the same pattern
// in a consumer's own .oxlintrc.json works immediately. A consumer extending
// the base config therefore inherits its rules but silently none of its
// ignores, and `devkit lint` walks their whole node_modules.
//
// Passing the list as flags is what does work. Reading it from the base config
// rather than restating it keeps one definition, so the key stays honest.
const IGNORE = base.ignorePatterns.flatMap((pattern) => ['--ignore-pattern', pattern]);

export default {
  kind: 'passthrough',
  describe: 'Run oxlint over the repo',
  run(argv) {
    // Prepended, so anything the caller passes still comes last and wins.
    runTool('oxlint', [...IGNORE, ...argv]);
  },
} satisfies PassthroughCommand;
