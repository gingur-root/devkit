import { fileURLToPath } from 'node:url';

import type { ParsedCommand } from '../../command.ts';
import { DASHBOARD_PORT, HOOKS_PORT } from '../../dashboard/constants.ts';

interface ServeOptions {
  port: number;
  hooksPort: number;
}

export default {
  kind: 'parsed',
  describe:
    'Serve the dashboard on localhost, behind Cloudflare Access (DASHBOARD_ACCESS_AUD), and the org webhook receiver that feeds it (WEBHOOK_SECRET)',
  configure(command) {
    command
      .option('--port <port>', 'port on localhost', Number, DASHBOARD_PORT)
      .option('--hooks-port <port>', 'webhook receiver port on localhost', Number, HOOKS_PORT);
  },
  async run({ port, hooksPort }) {
    const aud = process.env.DASHBOARD_ACCESS_AUD;
    if (!aud) throw new Error('DASHBOARD_ACCESS_AUD is not set.');
    const { createDashboard, WEB_DIST } = await import('../../dashboard/server.ts');
    // The page is built at start, so the VPS deploy needs no separate build step.
    const { build } = await import('vite-plus');
    const { default: tailwindcss } = await import('@tailwindcss/vite');
    await build({
      root: fileURLToPath(new URL('../../dashboard/web/', import.meta.url)),
      plugins: [tailwindcss()],
      // The shadcn components import `@/…`, mapped in tsconfig.json.
      resolve: { tsconfigPaths: true },
      build: { outDir: fileURLToPath(WEB_DIST), emptyOutDir: true },
      // Streamdown's 'use client' lines make Rolldown warn on every build.
      logLevel: 'error',
    });
    const { fetchAccessKeys } = await import('../../dashboard/access.ts');
    const secret = process.env.WEBHOOK_SECRET;
    if (!secret) throw new Error('WEBHOOK_SECRET is not set.');
    const { webhookBoard } = await import('../../dashboard/events.ts');
    const { createDedupe, createReceiver } = await import('../../webhooks/receiver.ts');
    const { pipelineHandler } = await import('../../webhooks/pipeline.ts');
    const { homedir } = await import('node:os');
    const { join } = await import('node:path');
    const board = webhookBoard();
    createReceiver(
      secret,
      [board.handle, pipelineHandler()],
      createDedupe(join(homedir(), '.local/state/devkit-dashboard/deliveries.json')),
    ).listen(hooksPort, '127.0.0.1');
    console.log(`Webhook receiver on http://127.0.0.1:${hooksPort}`);
    // Only cloudflared reaches them from outside, so both listen on loopback only.
    createDashboard(aud, fetchAccessKeys, undefined, undefined, board.source).listen(
      port,
      '127.0.0.1',
    );
    console.log(`Dashboard on http://127.0.0.1:${port}`);
  },
} satisfies ParsedCommand<ServeOptions>;
