import { Option } from 'commander';

import { STATUSES, type Status } from '../../agent/constants.ts';
import { ROLES } from '../../agent/roles.ts';
import type { ParsedCommand } from '../../command.ts';

interface StatusOptions {
  repo: string;
  issue: number;
  status: Status;
  note?: string;
  role?: string;
}

interface Comment {
  id: number;
  body: string | null;
  user: { type: string; id: number } | null;
}

export default {
  kind: 'parsed',
  describe: 'Add an issue to the Pipeline board and set its Status (GH_TOKEN)',
  configure(command) {
    command
      .requiredOption('--repo <owner/name>', 'repository')
      .requiredOption('--issue <number>', 'issue number', Number)
      .addOption(
        new Option('--status <status>', 'Status to set').choices(STATUSES).makeOptionMandatory(),
      )
      .option('--note <markdown>', "also write the stage's comment, which publish later replaces")
      .addOption(
        new Option('--role <role>', 'the stage whose comment --note writes').choices(
          Object.keys(ROLES),
        ),
      );
  },
  async run({ repo, issue, status, note, role }) {
    const { rest, restAll } = await import('../../agent/github.ts');
    const { setStatus } = await import('../../agent/board.ts');
    const { isStageComment, marker } = await import('../../agent/job.ts');
    const path = `/repos/${repo}/issues/${issue}`;
    if (note !== undefined) {
      if (!role) throw new Error('--note needs --role.');
      // Same lookup as publish, so a retry edits one comment instead of adding another.
      const body = `${marker(role)}\n\n${note}`;
      const existing = (await restAll<Comment>(`${path}/comments`)).find((c) =>
        isStageComment(c, role),
      );
      if (existing) await rest('PATCH', `/repos/${repo}/issues/comments/${existing.id}`, { body });
      else await rest('POST', `${path}/comments`, { body });
    }
    const { node_id } = await rest<{ node_id: string }>('GET', path);
    await setStatus(repo, node_id, status);
  },
} satisfies ParsedCommand<StatusOptions>;
