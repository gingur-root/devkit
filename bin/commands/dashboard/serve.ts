import type { ParsedCommand } from '../../command.ts';
import { DASHBOARD_PORT } from '../../dashboard/constants.ts';

interface ServeOptions {
  port: number;
}

export default {
  kind: 'parsed',
  describe: 'Serve the dashboard on localhost, behind Cloudflare Access (DASHBOARD_ACCESS_AUD)',
  configure(command) {
    command.option('--port <port>', 'port on localhost', Number, DASHBOARD_PORT);
  },
  async run({ port }) {
    const aud = process.env.DASHBOARD_ACCESS_AUD;
    if (!aud) throw new Error('DASHBOARD_ACCESS_AUD is not set.');
    const { createDashboard } = await import('../../dashboard/server.ts');
    const { fetchAccessKeys } = await import('../../dashboard/access.ts');
    // Only cloudflared reaches it from outside, so it listens on loopback only.
    createDashboard(aud, fetchAccessKeys).listen(port, '127.0.0.1');
    console.log(`Dashboard on http://127.0.0.1:${port}`);
  },
} satisfies ParsedCommand<ServeOptions>;
