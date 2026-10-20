import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from 'yaml';
import { z } from 'zod';

export const repoName = /^[a-z0-9][a-z0-9._-]*$/;
const nonEmpty = z.string().refine((value) => value.trim().length > 0);
const slug = nonEmpty.refine(
  (value) => !/[/\\\r\n]/.test(value) && value !== '.' && value !== '..',
);

export const entrySchema = z
  .object({
    name: nonEmpty,
    description: nonEmpty.refine((value) => !/[\r\n]/.test(value)),
    type: z.enum(['decision', 'fact']),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    source: nonEmpty,
    supersedes: slug.nullable(),
    evidence: z.array(
      z.object({
        at: z.string().refine((value) => {
          const colon = value.indexOf(':');
          const [owner = '', repo = '', ...extra] = value.slice(0, colon).split('/');
          const path = value.slice(colon + 1);
          return (
            colon > 0 &&
            extra.length === 0 &&
            repoName.test(owner) &&
            repoName.test(repo) &&
            path.length > 0 &&
            !path.startsWith('/') &&
            !/[\\:\r\n]/.test(path) &&
            !path.split('/').includes('..')
          );
        }),
        quote: nonEmpty,
      }),
    ),
  })
  .refine((entry) => entry.type !== 'fact' || entry.evidence.length > 0, { path: ['evidence'] });

export type Entry = z.infer<typeof entrySchema>;

export function folders(dir: string): string[] {
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return names.includes('_org') ? ['_org', ...names.filter((name) => name !== '_org')] : names;
}

/** Entry files in a folder. INDEX.md and MEMORY.md are generated or legacy, never entries. */
export function entryNames(dir: string, folder: string): string[] {
  return readdirSync(join(dir, folder), { withFileTypes: true })
    .filter((file) => file.isFile() && file.name.endsWith('.md'))
    .map((file) => file.name)
    .filter((name) => name !== 'INDEX.md' && name !== 'MEMORY.md')
    .sort();
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
