import { createServer, type Server } from 'node:http';

import { type FetchKeys, verifyAccessToken } from './access.ts';
import { ACCESS_JWT_HEADER } from './constants.ts';

const PAGE = (email: string) => `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dashboard</title>
<p>Signed in as ${email}. The prompt arrives with devkit#74.</p>
</html>`;

export function createDashboard(aud: string, keys: FetchKeys): Server {
  return createServer(async (req, res) => {
    const header = req.headers[ACCESS_JWT_HEADER];
    const email = await verifyAccessToken(
      typeof header === 'string' ? header : undefined,
      aud,
      keys,
    );
    if (!email) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden\n');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE(email));
  });
}
