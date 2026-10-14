// The dashboard (devkit#71) sits behind a Cloudflare Access app that admits
// only the operator. These are public identifiers, not secrets.
export const ACCESS_TEAM_URL = 'https://gingur.cloudflareaccess.com';
export const ACCESS_CERTS_URL = `${ACCESS_TEAM_URL}/cdn-cgi/access/certs`;
export const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion';
export const OPERATOR_EMAIL = 'troy.rhinehart@gmail.com';
export const DASHBOARD_PORT = 3000;
