import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { entryNames, folders, frontmatter, repoName, type Entry } from './format.ts';
import { githubReader, memoize, type Reader } from './reader.ts';
import { render } from './render.ts';

export { frontmatter };

export interface Failure {
  file: string;
  reason: string;
}

const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

export async function check(
  dir: string,
  options: { changed?: string[]; offline?: boolean; read?: Reader } = {},
): Promise<Failure[]> {
  const failures: Failure[] = [];
  const entries: { file: string; entry: Entry }[] = [];
  for (const folder of folders(dir)) {
    if (folder !== '_org' && !repoName.test(folder)) {
      failures.push({ file: folder, reason: 'invalid folder name' });
    }
    const names = entryNames(dir, folder);
    for (const name of names) {
      const file = `${folder}/${name}`;
      const entry = frontmatter(readFileSync(join(dir, file), 'utf8'));
      if (typeof entry === 'string') {
        failures.push({ file, reason: entry });
        continue;
      }
      if (entry.name !== name.slice(0, -3)) {
        failures.push({ file, reason: `name must equal filename slug ${name.slice(0, -3)}` });
      }
      if (entry.supersedes !== null && !names.includes(`${entry.supersedes}.md`)) {
        failures.push({ file, reason: `supersedes ${entry.supersedes} not found` });
      }
      entries.push({ file, entry });
    }
  }

  const index = render(dir);
  const lines = index.split('\n').length - 1;
  if (lines > 200) failures.push({ file: 'MEMORY.md', reason: 'generated index over 200 lines' });
  if (Buffer.byteLength(index) > 25 * 1024)
    failures.push({ file: 'MEMORY.md', reason: 'generated index over 25 KB' });

  if (!options.offline) {
    const read = memoize(options.read ?? githubReader);
    const changed = options.changed === undefined ? undefined : new Set(options.changed);
    for (const { file, entry } of entries) {
      for (const { at, quote } of entry.evidence) {
        if (changed && !changed.has(at)) continue;
        const text = await read(at);
        if (text === null) {
          failures.push({ file, reason: `evidence ${at} not found` });
        } else if (!collapse(text).includes(collapse(quote))) {
          failures.push({ file, reason: `quote not found in ${at}` });
        }
      }
    }
  }
  return failures;
}
