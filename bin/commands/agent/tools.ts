import { Option } from 'commander';

import { ROLES, type RoleName } from '../../agent/roles.ts';
import type { ParsedCommand } from '../../command.ts';

export default {
  kind: 'parsed',
  describe: 'Print the role’s MCP configs or Bitwarden credential requests',
  configure(command) {
    command
      .addOption(
        new Option('--role <role>', 'role to render')
          .choices(Object.keys(ROLES))
          .makeOptionMandatory(),
      )
      .option('--in <dir>', 'job directory holding tools.json')
      .option('--secrets', 'print <uuid> > <ENV_NAME> lines for secrets.fetch');
  },
  async run(options) {
    const { loadTools, renderTools } = await import('../../agent/tools.ts');
    const rendered = renderTools(loadTools(options.in), options.role);
    if (options.secrets) {
      for (const [name, uuid] of Object.entries(rendered.secrets))
        process.stdout.write(`${uuid} > ${name}\n`);
    } else process.stdout.write(`${JSON.stringify(rendered, null, 2)}\n`);
  },
} satisfies ParsedCommand<{ role: RoleName; in?: string; secrets?: boolean }>;
