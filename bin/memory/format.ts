import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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

/** A missing index or MEMORY.md is a check failure; other I/O errors stay loud. */
export function readOptional(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function indexLines(dir: string, folder: string): string[] | null {
  const text = readOptional(join(dir, folder, 'INDEX.md'));
  return text === null ? null : text.split(/\r?\n/).filter((line) => line.startsWith('- ['));
}
