// The dashboard (devkit#71) sits behind a Cloudflare Access app that admits
// only the operator. These are public identifiers, not secrets.
export const ACCESS_TEAM_URL = 'https://gingur.cloudflareaccess.com';
export const ACCESS_CERTS_URL = `${ACCESS_TEAM_URL}/cdn-cgi/access/certs`;
export const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';
export const OPERATOR_EMAIL = 'troy.rhinehart@gmail.com';
export const DASHBOARD_PORT = 3000;
export const DASHBOARD_ORIGIN = 'https://dashboard.gingur.com';
export const ORG = 'gingur-root';
// A GitHub repository name; checked wherever a client or the agent supplies one.
export const REPO_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
// What the page hears on /api/events (devkit#100), whichever source sent it.
export const BOARD_EVENT = { cardChanged: 'card.changed', boardChanged: 'board.changed' } as const;
