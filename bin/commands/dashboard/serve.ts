import { fileURLToPath } from 'node:url';

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
    const { createDashboard, WEB_DIST } = await import('../../dashboard/server.ts');
    // The page is built at start, so the VPS deploy needs no separate build step.
    const { build } = await import('vite-plus');
    await build({
      root: fileURLToPath(new URL('../../dashboard/web/', import.meta.url)),
      // Relative asset URLs, so the build also works under /pr/<n>/ (devkit#93).
      base: './',
      build: { outDir: fileURLToPath(WEB_DIST), emptyOutDir: true },
      // Streamdown's 'use client' lines make Rolldown warn on every build.
      logLevel: 'error',
    });
    const { fetchAccessKeys } = await import('../../dashboard/access.ts');
    // Only cloudflared reaches it from outside, so it listens on loopback only.
    createDashboard(aud, fetchAccessKeys).listen(port, '127.0.0.1');
    console.log(`Dashboard on http://127.0.0.1:${port}`);
  },
} satisfies ParsedCommand<ServeOptions>;
