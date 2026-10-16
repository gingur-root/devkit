// The dashboard writes GitHub as the pipeline App (devkit#71). In CI the
// `app.token` action mints the token. This long-running server mints its own
// and refreshes it before the hour-long token expires.
import { sign } from 'node:crypto';

const REFRESH_MARGIN_MS = 5 * 60_000;

let current: { token: string; expiresAt: number } | undefined;

function base64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** The App's own JWT, which may only mint installation tokens. */
export function appJwt(clientId: string, privateKey: string, now = Date.now() / 1000): string {
  // Backdated a minute for clock drift, as GitHub's docs advise.
  const body = `${base64url({ alg: 'RS256', typ: 'JWT' })}.${base64url({ iat: Math.floor(now) - 60, exp: Math.floor(now) + 540, iss: clientId })}`;
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), privateKey).toString('base64url')}`;
}

/** Keeps GH_TOKEN, which bin/agent/github.ts reads, a live installation token. */
export async function refreshGhToken(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (current && current.expiresAt - Date.now() > REFRESH_MARGIN_MS) return;
  const { PIPELINE_APP_CLIENT_ID, PIPELINE_APP_INSTALLATION_ID, PIPELINE_APP_KEY } = env;
  // No App key: on the WSL desk, github.ts falls back to the operator's own login.
  if (!PIPELINE_APP_KEY) return;
  if (!PIPELINE_APP_CLIENT_ID || !PIPELINE_APP_INSTALLATION_ID) {
    throw new Error(
      'PIPELINE_APP_KEY needs PIPELINE_APP_CLIENT_ID and PIPELINE_APP_INSTALLATION_ID.',
    );
  }
  const response = await fetch(
    `https://api.github.com/app/installations/${PIPELINE_APP_INSTALLATION_ID}/access_tokens`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${appJwt(PIPELINE_APP_CLIENT_ID, PIPELINE_APP_KEY)}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        permissions: {
          issues: 'write',
          organization_projects: 'write',
          actions: 'write',
          pull_requests: 'read',
          checks: 'read',
        },
      }),
    },
  );
  if (!response.ok) throw new Error(`App token: HTTP ${response.status} ${await response.text()}`);
  const { token, expires_at } = (await response.json()) as { token: string; expires_at: string };
  current = { token, expiresAt: Date.parse(expires_at) };
  env.GH_TOKEN = token;
}
