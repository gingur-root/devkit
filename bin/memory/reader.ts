import { rest } from '../agent/github.ts';

/** File text at the repo's default-branch HEAD, or null when the file doesn't exist. */
export type Reader = (at: string) => Promise<string | null>;

export function memoize(read: Reader): Reader {
  const cache = new Map<string, Promise<string | null>>();
  return (at) => {
    let pending = cache.get(at);
    if (!pending) {
      pending = read(at);
      cache.set(at, pending);
    }
    return pending;
  };
}

export const githubReader: Reader = async (at) => {
  const colon = at.indexOf(':');
  const [owner = '', repo = ''] = at.slice(0, colon).split('/');
  const path = at
    .slice(colon + 1)
    .split('/')
    .map(encodeURIComponent)
    .join('/');
  let file: { content: string; encoding: string };
  try {
    file = await rest(
      'GET',
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path}`,
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes(' 404 ')) return null;
    throw error;
  }
  if (file.encoding !== 'base64') {
    throw new Error(`Evidence ${at}: expected base64 encoding, got ${file.encoding}`);
  }
  return Buffer.from(file.content, 'base64').toString('utf8');
};
