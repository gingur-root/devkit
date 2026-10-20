import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from 'yaml';

import { entrySchema, folders, indexLines, readOptional, repoName, type Entry } from './format.ts';
import { githubReader, memoize, type Reader } from './reader.ts';
import { render } from './render.ts';

export interface Failure {
  file: string;
  reason: string;
}

export function frontmatter(text: string): Entry | string {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') return 'missing frontmatter';
  const end = lines.indexOf('---', 1);
  if (end === -1) return 'bad frontmatter: missing closing ---';
  let value: unknown;
  try {
    value = parse(lines.slice(1, end).join('\n'));
  } catch {
    return 'bad frontmatter: invalid YAML';
  }
  const result = entrySchema.safeParse(value);
  if (!result.success) {
    const fields = [
      ...new Set(result.error.issues.map((issue) => issue.path.join('.') || 'entry')),
    ];
    return `bad frontmatter: ${fields.join(', ')}`;
  }
  return result.data;
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
    const names = readdirSync(join(dir, folder), { withFileTypes: true })
      .filter((file) => file.isFile() && file.name.endsWith('.md') && file.name !== 'INDEX.md')
      .map((file) => file.name)
      .sort();
    const indexed = new Set<string>();
    for (const line of indexLines(dir, folder) ?? []) {
      const target = /^- \[[^\]]+\]\(([^)]+)\)/.exec(line)?.[1];
      if (!target) {
        failures.push({ file: `${folder}/INDEX.md`, reason: 'invalid index line' });
      } else if (!names.includes(target)) {
        failures.push({ file: `${folder}/INDEX.md`, reason: `dangling link ${target}` });
      } else {
        indexed.add(target);
      }
    }
    for (const name of names) {
      const file = `${folder}/${name}`;
      if (!indexed.has(name)) failures.push({ file, reason: 'unindexed entry' });
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

  const memory = readOptional(join(dir, 'MEMORY.md'));
  if (memory !== render(dir)) failures.push({ file: 'MEMORY.md', reason: 'out of sync' });
  if (memory !== null) {
    const lines = memory.split('\n').length - (memory.endsWith('\n') ? 1 : 0);
    if (lines > 200) failures.push({ file: 'MEMORY.md', reason: 'over 200 lines' });
    if (Buffer.byteLength(memory) > 25 * 1024)
      failures.push({ file: 'MEMORY.md', reason: 'over 25 KB' });
  }

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
