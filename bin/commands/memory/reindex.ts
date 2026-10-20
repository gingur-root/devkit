import type { ParsedCommand } from '../../command.ts';

export default {
  kind: 'parsed',
  describe: 'Write MEMORY.md (a local, uncommitted index) from entry frontmatter',
  configure(command) {
    command.requiredOption('--dir <dir>', 'memory directory');
  },
  async run({ dir }) {
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { render } = await import('../../memory/render.ts');
    writeFileSync(join(dir, 'MEMORY.md'), render(dir));
  },
} satisfies ParsedCommand<{ dir: string }>;
