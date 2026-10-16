// The dashboard (devkit#71) sits behind a Cloudflare Access app that admits
// only the operator. These are public identifiers, not secrets.
export const ACCESS_TEAM_URL = 'https://gingur.cloudflareaccess.com';
export const ACCESS_CERTS_URL = `${ACCESS_TEAM_URL}/cdn-cgi/access/certs`;
export const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';
export const OPERATOR_EMAIL = 'troy.rhinehart@gmail.com';
export const DASHBOARD_PORT = 3000;
// Under Cloudflare's 100 s idle cutoff, so a quiet stream stays open.
export const KEEP_ALIVE_MS = 25_000;
// The org webhook receiver (devkit#118), public with no Access: its own port, so no dashboard route is reachable there.
export const HOOKS_PORT = 3001;
export const DASHBOARD_ORIGIN = 'https://dashboard.gingur.com';
export const ORG = 'gingur-root';
// A GitHub repository name; checked wherever a client or the agent supplies one.
export const REPO_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
// What the page hears on /api/events (devkit#100), whichever source sent it.
export const BOARD_EVENT = { cardChanged: 'card.changed', boardChanged: 'board.changed' } as const;
// A review that only comments, which never overrides a reviewer's earlier verdict.
export const COMMENTED_REVIEW = 'COMMENTED';
