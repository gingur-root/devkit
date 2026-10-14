// Every user on the VPS can reach the dashboard's port without passing Access,
// so the server trusts a request only when it carries a valid Access token:
// signed by the team's keys, for this app's AUD, unexpired, and the operator's.
import { createPublicKey, type JsonWebKey, verify } from 'node:crypto';

import { ACCESS_CERTS_URL, ACCESS_TEAM_URL, OPERATOR_EMAIL } from './constants.ts';

interface Claims {
  aud?: string | string[];
  email?: string;
  exp?: number;
  nbf?: number;
  iss?: string;
}

type Jwk = JsonWebKey & { kid?: string };
export type FetchKeys = () => Promise<Jwk[]>;

// shortcut: fetches the keys on every request, fine for one operator; cache by
// kid if requests ever feel slow.
export async function fetchAccessKeys(): Promise<Jwk[]> {
  const response = await fetch(ACCESS_CERTS_URL);
  if (!response.ok) throw new Error(`Access certs: HTTP ${response.status}`);
  return ((await response.json()) as { keys: Jwk[] }).keys;
}

function decode<T>(part: string): T {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as T;
}

/** The operator's email when the token is valid for `aud`, else null. */
export async function verifyAccessToken(
  token: string | undefined,
  aud: string,
  keys: FetchKeys,
  now = Date.now() / 1000,
): Promise<string | null> {
  const parts = token?.split('.') ?? [];
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts as [string, string, string];
  try {
    const { alg, kid } = decode<{ alg?: string; kid?: string }>(header);
    if (alg !== 'RS256') return null;
    const jwk = (await keys()).find((key) => key.kid === kid);
    if (!jwk) return null;
    const signed = Buffer.from(`${header}.${payload}`);
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    if (!verify('RSA-SHA256', signed, key, Buffer.from(signature, 'base64url'))) return null;

    const claims = decode<Claims>(payload);
    const audiences = [claims.aud].flat();
    if (!audiences.includes(aud)) return null;
    if (claims.iss !== ACCESS_TEAM_URL) return null;
    if (typeof claims.exp !== 'number' || claims.exp <= now) return null;
    if (claims.nbf !== undefined && claims.nbf > now) return null;
    return claims.email === OPERATOR_EMAIL ? claims.email : null;
  } catch {
    return null;
  }
}
