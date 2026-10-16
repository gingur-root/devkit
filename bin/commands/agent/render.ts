import { Option } from 'commander';

import { ROLES } from '../../agent/roles.ts';
import type { RenderOptions } from '../../agent/render.ts';
import type { ParsedCommand } from '../../command.ts';

export default {
  kind: 'parsed',
  describe: "Render a stage's job file and issue snapshot from GitHub (GH_TOKEN)",
  configure(command) {
    command
      .requiredOption('--repo <owner/name>', 'repository')
      .requiredOption('--issue <number>', 'issue number', Number)
      .addOption(
        new Option('--role <role>', 'role to render for')
          .choices(Object.keys(ROLES))
          .makeOptionMandatory(),
      )
      .option(
        '--source <sha>',
        'commit the stage works from (default: the head of its default branch)',
      )
      .option('--base <sha>', "a review's base: the commit the candidate was built from")
      .requiredOption('--app-id <id>', "the pipeline App's ID; its text counts as trusted", Number)
      .option('--actor <id>', 'who requested the stage (may be a dispatch input)', Number)
      .option(
        '--dispatcher <id>',
        'who triggered the workflow (github.actor_id)',
        Number,
        process.env.GITHUB_ACTOR_ID ? Number(process.env.GITHUB_ACTOR_ID) : undefined,
      )
      .requiredOption('--out <dir>', 'directory to write ($AGENT_IN)');
  },
  async run(options) {
    const { render } = await import('../../agent/render.ts');
    await render(options);
  },
} satisfies ParsedCommand<RenderOptions>;
