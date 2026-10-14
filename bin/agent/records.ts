// Uploads a stage's job and output directories to the R2 run-records bucket
// (devkit#14, infra "Run records"), keyed `<repo>/<issue>/<runId>/<stage>/…`.
// Signs S3 PUTs itself rather than add an SDK for one request type.

import { createHash, createHmac } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { z } from 'zod';

/** The keys Bitwarden `pipeline` holds, as the publish job's `R2_RUNS` JSON. */
const RecordsConfig = z.object({
  R2_RUNS_ENDPOINT: z.string().url(),
  R2_RUNS_BUCKET: z.string().min(1),
  R2_RUNS_ACCESS_KEY_ID: z.string().min(1),
  R2_RUNS_SECRET_ACCESS_KEY: z.string().min(1),
});
type RecordsConfig = z.infer<typeof RecordsConfig>;

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) =>
  createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding per path segment, as SigV4's canonical URI wants. */
function encodeKey(key: string): string {
  return key
    .split('/')
    .map((part) =>
      encodeURIComponent(part).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join('/');
}

/** A SigV4-signed path-style PUT; R2's region is always `auto`. */
export function signedPut(
  config: RecordsConfig,
  key: string,
  body: Buffer,
  now = new Date(),
): { url: string; headers: Record<string, string> } {
  const url = new URL(
    `${config.R2_RUNS_ENDPOINT.replace(/\/$/, '')}/${config.R2_RUNS_BUCKET}/${encodeKey(key)}`,
  );
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const scope = `${amzDate.slice(0, 8)}/auto/s3/aws4_request`;
  const payload = sha256(body);
  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-content-sha256': payload,
    'x-amz-date': amzDate,
  };
  const names = Object.keys(headers).sort();
  const canonical = [
    'PUT',
    url.pathname,
    '',
    ...names.map((name) => `${name}:${headers[name]}`),
    '',
    names.join(';'),
    payload,
  ].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  let signingKey: Buffer = hmac(`AWS4${config.R2_RUNS_SECRET_ACCESS_KEY}`, amzDate.slice(0, 8));
  for (const part of ['auto', 's3', 'aws4_request']) signingKey = hmac(signingKey, part);
  const signature = createHmac('sha256', signingKey).update(toSign).digest('hex');
  const { host: _, ...sent } = headers;
  return {
    url: url.href,
    headers: {
      ...sent,
      authorization: `AWS4-HMAC-SHA256 Credential=${config.R2_RUNS_ACCESS_KEY_ID}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
    },
  };
}

function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

/**
 * Uploads each directory under `<prefix>/<name>/` and returns the prefix as an
 * `r2://` URL, or null when the publish job has no records keys (the WSL desk).
 */
export async function uploadRecords(
  raw: string | undefined,
  prefix: string,
  dirs: Record<string, string>,
): Promise<string | null> {
  const parsed = RecordsConfig.safeParse(raw ? JSON.parse(raw) : {});
  if (!parsed.success) return null;
  const config = parsed.data;
  for (const [name, dir] of Object.entries(dirs)) {
    let paths: string[];
    try {
      paths = files(dir);
    } catch {
      continue; // the stage died before writing it
    }
    for (const path of paths) {
      const key = `${prefix}/${name}/${relative(dir, path)}`;
      const body = readFileSync(path);
      const { url, headers } = signedPut(config, key, body);
      const response = await fetch(url, { method: 'PUT', headers, body });
      if (!response.ok) throw new Error(`R2 PUT ${key} returned ${response.status}.`);
    }
  }
  return `r2://${config.R2_RUNS_BUCKET}/${prefix}/`;
}
